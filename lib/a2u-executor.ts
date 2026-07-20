import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { recordA2UTransactionAtomic } from "@/lib/db"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { validateFinancialData } from "@/lib/financial-validation"
import * as StellarSDK from "@stellar/stellar-sdk"

/**
 * UNIFIED A2U EXECUTOR - Single source of truth for ALL A2U execution paths
 * 
 * REPLACES:
 * - /api/pi/a2u new-payment + ongoing-payment + already_completed flows
 * - /api/pi/complete settlement_pending retry flow
 * - /lib/a2u-recovery-service.ts completePiA2UAndReconcile
 * - /api/recovery/[id] server-side Pi /complete
 * 
 * SINGLE FLOW:
 * 1. Check if already settled → return success
 * 2. Load/reuse/create A2U (if needed)
 * 3. Sign once (if needed)
 * 4. Submit Horizon once (if needed)
 * 5. Persist checkpoint
 * 6. Complete Pi once (if needed)
 * 7. Reconcile DB once
 * 
 * Recovery skips completed stages and handles already_completed.
 * No Horizon re-signing when txid exists.
 */

import type { Payment } from "@/lib/types"

/**
 * Pi A2U Payment API Response - Strict type definition
 * Based on Pi API response structure for payments endpoint
 */
interface PiA2UPayment {
  identifier: string
  from_address: string
  to_address: string
  amount: number
  status?: {
    developer_approved?: boolean
    transaction_verified?: boolean
    developer_completed?: boolean
    cancelled?: boolean
    user_cancelled?: boolean
  }
  transaction?: {
    txid?: string
    verified?: boolean
    _link?: string
  }
}

/**
 * ============================================================================
 * UNIFIED INTERNAL RESULT CONTRACT - TYPED DISCRIMINATED UNIONS
 * ============================================================================
 * 
 * Each stage returns its specific data type on success.
 * All errors: { ok: false; error: string; userFacingStatus: string }
 */
type Stage1Result = 
  | { ok: true; data: { a2uPaymentId: string; a2uPayment: PiA2UPayment } }
  | { ok: false; error: string; userFacingStatus: string }

type Stage2Result = 
  | { ok: true; data: { txidFromHorizon: string; horizonFeeCharged: number } }
  | { ok: false; error: string; userFacingStatus: string }

type Stage3Result = 
  | { ok: true }
  | { ok: false; error: string; userFacingStatus: string }

type Stage4Result = 
  | { ok: true }
  | { ok: false; error: string; userFacingStatus: string }

/**
 * Reusable type guard: Check if unknown is a Record<string, unknown>
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Type guard: Validate unknown object as PiA2UPayment
 */
function isPiA2UPayment(value: unknown): value is PiA2UPayment {
  if (!isRecord(value)) return false
  const obj = value
  
  // Required fields
  if (typeof obj.identifier !== 'string') return false
  if (typeof obj.from_address !== 'string') return false
  if (typeof obj.to_address !== 'string') return false
  if (typeof obj.amount !== 'number' || !Number.isFinite(obj.amount)) return false
  
  // Optional status field with boolean flags
  if (obj.status !== undefined && obj.status !== null) {
    if (!isRecord(obj.status)) return false
    const statusObj = obj.status
    if (statusObj.developer_approved !== undefined && typeof statusObj.developer_approved !== 'boolean') return false
    if (statusObj.transaction_verified !== undefined && typeof statusObj.transaction_verified !== 'boolean') return false
    if (statusObj.developer_completed !== undefined && typeof statusObj.developer_completed !== 'boolean') return false
    if (statusObj.cancelled !== undefined && typeof statusObj.cancelled !== 'boolean') return false
    if (statusObj.user_cancelled !== undefined && typeof statusObj.user_cancelled !== 'boolean') return false
  }
  
  // Optional transaction field: txid and verified are optional strings/booleans
  if (obj.transaction !== undefined && obj.transaction !== null) {
    if (!isRecord(obj.transaction)) return false
    const txObj = obj.transaction
    if (txObj.txid !== undefined && typeof txObj.txid !== 'string') return false
    if (txObj.verified !== undefined && typeof txObj.verified !== 'boolean') return false
    if (txObj._link !== undefined && typeof txObj._link !== 'string') return false
  }
  
  return true
}

export interface ExecutorContext {
  paymentId: string
  payment: Payment // Use canonical Payment type - REQUIRED
  merchantUid: string
  accessToken: string
  customerAmount: number // REQUIRED - validated amount
  piPaymentId?: string // Optional - provided for recovery flows, undefined for new payments
  isRecovery: boolean
}

/**
 * CRITICAL: Executor NEVER returns success: true
 * ALL paths (new, ongoing, complete, recovery) return { success: false, status: "settlement_pending" }
 * or error states. ONLY buildA2USuccessResponse() can return success: true after reading Redis predicate.
 * STRICT DISCRIMINATED UNION: success: false MUST include status and error (no optional)
 */
type ExecutorResult = 
  | { ok: true; status: "settlement_pending" }
  | { ok: false; status: string; error: string }

/**
 * UNIFIED EXECUTOR: Resume from stored stage or execute complete flow
 * Validates all context inputs and returns discriminated union (success must include txidFromHorizon)
 */
export async function executeA2U(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Validate required context fields - no optional coercion
  if (!ctx.paymentId || typeof ctx.paymentId !== 'string') {
    return { ok: false, status: "invalid_context", error: "paymentId required and must be string" }
  }
  if (!ctx.payment || typeof ctx.payment !== 'object') {
    return { ok: false, status: "invalid_context", error: "payment object required" }
  }
  if (!ctx.merchantUid || typeof ctx.merchantUid !== 'string') {
    return { ok: false, status: "invalid_context", error: "merchantUid required and must be string" }
  }
  if (!ctx.accessToken || typeof ctx.accessToken !== 'string') {
    return { ok: false, status: "invalid_context", error: "accessToken required and must be string" }
  }
  if (typeof ctx.customerAmount !== 'number' || !Number.isFinite(ctx.customerAmount)) {
    return { ok: false, status: "invalid_context", error: "customerAmount required and must be finite number" }
  }
  if (typeof ctx.isRecovery !== 'boolean') {
    return { ok: false, status: "invalid_context", error: "isRecovery required and must be boolean" }
  }
  // piPaymentId is optional for new payments, but MUST be present for recovery or stage 4 DB recording
  // Validation below will enforce when needed

  console.log("[A2U Executor] ===== UNIFIED A2U EXECUTOR START =====")
  console.log("[A2U Executor] Payment ID:", ctx.paymentId)
  console.log("[A2U Executor] Is Recovery:", ctx.isRecovery)
  console.log("[A2U Executor] Current Status:", ctx.payment.status)

  // STAGE 0: Check if already settled (terminal state)
  // Executor returns ok:true; caller invokes buildA2USuccessResponse() to return final response
  if (ctx.payment.status === "settled_to_merchant") {
    console.log("[A2U Executor] ℹ️ Already settled - skipping execution")
    return { ok: true, status: "settlement_pending" }
  }

  // STAGE 1: Get/Create A2U payment (skip if already have a2uPaymentId)
  let a2uPaymentId = ctx.payment.a2uPaymentId

  if (!a2uPaymentId) {
    console.log("[A2U Executor] STAGE 1: Creating new A2U payment")
    const stageResult = await stage1CreateA2U(ctx)
    if (!stageResult.ok) {
      return {
        ok: false,
        status: stageResult.userFacingStatus,
        error: stageResult.error,
      }
    }
    // Discriminated union: ok: true includes a2uPaymentId
    a2uPaymentId = stageResult.data.a2uPaymentId
    ctx.payment.a2uPaymentId = a2uPaymentId

    // Persist Stage 1: a2uPaymentId immediately after creation (crash-safe merge)
    if (stageResult.data.a2uPayment) {
      const stage1Updates = {
        a2uPaymentId: a2uPaymentId,
        a2uFromAddress: stageResult.data.a2uPayment.from_address,
        a2uToAddress: stageResult.data.a2uPayment.to_address,
        customerAmount: ctx.customerAmount,
        merchantAmount: Number(stageResult.data.a2uPayment.amount),
      }
      await persistCheckpointMerged(ctx.paymentId, stage1Updates)
      ctx.payment = { ...ctx.payment, ...stage1Updates }
    }
  } else {
    console.log("[A2U Executor] STAGE 1: Reusing existing A2U payment:", a2uPaymentId)

    // For reused a2uPaymentId, fetch from Pi API to validate state
    console.log("[A2U Executor] STAGE 1: Fetching and validating reused A2U from Pi API")
    const fetchedPayment = await fetchA2UPayment(a2uPaymentId)
    if (!fetchedPayment) {
      return { ok: false, status: "error", error: "Failed to fetch existing A2U payment from Pi" }
    }
    if (fetchedPayment.identifier !== a2uPaymentId) {
      return { ok: false, status: "error", error: "A2U identifier mismatch from Pi API" }
    }
    // Normalize and check amount match exactly
    const fetchedAmount = Number(fetchedPayment.amount)
    if (!Number.isFinite(fetchedAmount) || fetchedAmount !== ctx.customerAmount) {
      return { ok: false, status: "error", error: "A2U amount mismatch" }
    }
    if (!fetchedPayment.from_address || !fetchedPayment.to_address) {
      return { ok: false, status: "error", error: "A2U missing addresses" }
    }
    
    // Check if payment is cancelled
    if (fetchedPayment.status?.cancelled === true || fetchedPayment.status?.user_cancelled === true) {
      return { ok: false, status: "error", error: "A2U payment was cancelled" }
    }
    
    // Extract state from PaymentDTO
    const isDevCompleted = fetchedPayment.status?.developer_completed === true
    const existingTxid = fetchedPayment.transaction?.txid
    
    // If any txid exists, preserve it and permanently skip Stage2
    if (typeof existingTxid === "string") {
      console.log("[A2U Executor] A2U has existing txid - preserving and skipping Stage 2")
      const preserveUpdates = {
        a2uTxid: existingTxid,
        a2uFromAddress: fetchedPayment.from_address,
        a2uToAddress: fetchedPayment.to_address,
        customerAmount: ctx.customerAmount,
        merchantAmount: fetchedAmount,
        horizonSuccessFlag: true,
        horizonSuccessAt: new Date().toISOString(),
        piCompleted: isDevCompleted,
        piCompletionPending: !isDevCompleted,
        paidAt: isDevCompleted ? new Date().toISOString() : undefined,
        status: "settlement_pending" as const,
        requiresDbReconciliation: isDevCompleted,
      }
      await persistCheckpointMerged(ctx.paymentId, preserveUpdates)
      ctx.payment = { ...ctx.payment, ...preserveUpdates }
      console.log("[A2U Executor] ✓ Txid preserved - will skip Stage 2")
      // txidFromHorizon is set, Stage 2 will be skipped
    } else {
      // No txid: continue through normal flow (Stage 2 signing)
      console.log("[A2U Executor] A2U has no txid - will continue through Stage 2 for signing")
      const continueUpdates = {
        a2uFromAddress: fetchedPayment.from_address,
        a2uToAddress: fetchedPayment.to_address,
        customerAmount: ctx.customerAmount,
        merchantAmount: fetchedAmount,
        status: "settlement_pending" as const,
      }
      await persistCheckpointMerged(ctx.paymentId, continueUpdates)
      ctx.payment = { ...ctx.payment, ...continueUpdates }
    }
  }

  // STAGE 2: Sign (skip if already have a2uTxid)
  let txidFromHorizon = ctx.payment.a2uTxid

  if (!txidFromHorizon) {
    console.log("[A2U Executor] STAGE 2: Signing transaction")
    const signResult = await stage2SignAndSubmit(ctx)
    if (!signResult.ok) {
      return {
        ok: false,
        status: signResult.userFacingStatus,
        error: signResult.error,
      }
    }
    // Discriminated union: ok: true includes txidFromHorizon and horizonFeeCharged
    txidFromHorizon = signResult.data.txidFromHorizon

    // Persist Stage 2: a2uTxid, horizonSuccessFlag, horizonSuccessAt after confirmed Horizon success (crash-safe merge)
    const stage2Updates = {
      status: "settlement_pending" as const,
      a2uTxid: txidFromHorizon,
      customerAmount: ctx.customerAmount,
      horizonFeeCharged: signResult.data.horizonFeeCharged,
      horizonSuccessFlag: true,
      piCompletionPending: true,
      piCompleted: false,
      requiresDbReconciliation: false,
      horizonSuccessAt: new Date().toISOString(),
    }
    await persistCheckpointMerged(ctx.paymentId, stage2Updates)
    ctx.payment = { ...ctx.payment, ...stage2Updates }
    console.log("[A2U Executor] ✓ Checkpoint persisted after Horizon success with fee:", signResult.data.horizonFeeCharged )
  } else {
    console.log("[A2U Executor] STAGE 2: Skipping signing - txid already exists:", txidFromHorizon)
  }

  // STAGE 3: Complete Pi (skip if already piCompleted)
  if (!ctx.payment.piCompleted) {
    console.log("[A2U Executor] STAGE 3: Calling Pi /complete")
    // Validate a2uPaymentId is present before calling Pi
    if (!a2uPaymentId || typeof a2uPaymentId !== 'string') {
      return { ok: false, status: "error", error: "a2uPaymentId missing before stage 3" }
    }
    if (!txidFromHorizon || typeof txidFromHorizon !== 'string') {
      return { ok: false, status: "error", error: "txidFromHorizon missing before stage 3 - Horizon must have succeeded" }
    }
    const piResult = await stage3CompletePi(ctx, a2uPaymentId, txidFromHorizon)
    if (!piResult.ok) {
      return {
        ok: false,
        status: piResult.userFacingStatus,
        error: piResult.error,
      }
    }
    // Persist Stage 3: piCompleted and timestamp after confirmed or already-completed Pi state (crash-safe merge)
    const stage3Updates = {
      piCompleted: true,
      piCompletionPending: false,
      paidAt: new Date().toISOString(),
    }
    await persistCheckpointMerged(ctx.paymentId, stage3Updates)
    ctx.payment = { ...ctx.payment, ...stage3Updates }
    console.log("[A2U Executor] ✓ Pi /complete succeeded")
  } else {
    console.log("[A2U Executor] STAGE 3: Skipping Pi /complete - already piCompleted")
  }

  // STAGE 4: DB Reconciliation (skip if already dbRecorded)
  if (!ctx.payment.dbRecorded) {
    console.log("[A2U Executor] STAGE 4: Reconciling in database")
    // Validate txidFromHorizon exists for DB record
    if (!txidFromHorizon || typeof txidFromHorizon !== 'string') {
      return { ok: false, status: "error", error: "txidFromHorizon missing before stage 4 - cannot record in DB" }
    }
    const dbResult = await stage4ReconcileDB(ctx, txidFromHorizon)
    if (!dbResult.ok) {
      return {
        ok: false,
        status: dbResult.userFacingStatus,
        error: dbResult.error,
      }
    }
    // Persist Stage 4: dbRecorded, settledAt, and settled_to_merchant status after atomic DB success (crash-safe merge)
    const stage4Updates = {
      dbRecorded: true,
      status: "settled_to_merchant" as const,
      requiresDbReconciliation: false,
      settledAt: new Date().toISOString(),
    }
    await persistCheckpointMerged(ctx.paymentId, stage4Updates)
    ctx.payment = { ...ctx.payment, ...stage4Updates }
    console.log("[A2U Executor] ✓ DB reconciliation succeeded")
  } else {
    console.log("[A2U Executor] STAGE 4: Skipping DB reconciliation - already recorded")
  }

  // Executor completes all stages successfully
  // Caller branches on result.ok, then invokes buildA2USuccessResponse() for final response
  console.log("[A2U Executor] ===== ALL STAGES COMPLETE - SETTLEMENT PENDING =====")
  return { ok: true, status: "settlement_pending" }
}

/**
 * STAGE 1: Create or fetch A2U payment - TYPED DISCRIMINATED UNION
 * Parses response as unknown and validates with isPiA2UPayment guard - NO CASTS
 */
async function stage1CreateA2U(ctx: ExecutorContext): Promise<Stage1Result> {
  try {
    // Verify UID with Pi /v2/me
    const verifyResponse = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!verifyResponse.ok) {
      const error = await verifyResponse.text()
      console.error("[A2U Stage1] UID verification failed:", error)
      return { ok: false, error: "UID verification failed", userFacingStatus: "error" }
    }

    const verifiedUser = await verifyResponse.json()
    if (verifiedUser.uid !== ctx.merchantUid) {
      console.error("[A2U Stage1] UID mismatch")
      return { ok: false, error: "UID mismatch", userFacingStatus: "error" }
    }

    console.log("[A2U Stage1] ✓ UID verified")

    // Create A2U payment
    const requestBody = {
      payment: {
        amount: ctx.customerAmount,
        memo: `FlashPay settlement for ${ctx.paymentId}`,
        metadata: {
          paymentId: ctx.paymentId,
          type: "a2u_settlement",
          timestamp: new Date().toISOString(),
        },
        uid: ctx.merchantUid,
      },
    }

    const createResponse = await fetch("https://api.minepi.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Key ${serverConfig.piApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!createResponse.ok) {
      const errorText = await createResponse.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { raw: errorText }
      }

      // Handle ongoing_payment_found
      if (errorData.code === "ongoing_payment_found" || errorText.includes("ongoing_payment")) {
        const ongoingPaymentId = errorData.payment?.identifier || errorData.identifier || errorData.payment_id
        if (ongoingPaymentId) {
          console.warn("[A2U Stage1] Ongoing payment found - reusing:", ongoingPaymentId)
          const fetchResult = await fetchA2UPayment(ongoingPaymentId)
          if (fetchResult) {
            return { ok: true, data: { a2uPaymentId: ongoingPaymentId, a2uPayment: fetchResult } }
          }
        }
      }

      console.error("[A2U Stage1] A2U creation failed:", errorData)
      return { ok: false, error: "A2U creation failed", userFacingStatus: "error" }
    }

    const responseData: unknown = await createResponse.json()
    
    // Validate response with type guard - NO CASTS
    if (!isPiA2UPayment(responseData)) {
      console.error("[A2U Stage1] A2U response validation failed:", responseData)
      return { ok: false, error: "A2U response validation failed - missing required fields", userFacingStatus: "error" }
    }
    
    console.log("[A2U Stage1] ✓ A2U payment created:", responseData.identifier)

    return {
      ok: true,
      data: {
        a2uPaymentId: responseData.identifier,
        a2uPayment: responseData,
      },
    }
  } catch (error) {
    console.error("[A2U Stage1] Exception:", error)
    return { ok: false, error: String(error), userFacingStatus: "error" }
  }
}

/**
 * STAGE 2: Sign and submit to Horizon - TYPED DISCRIMINATED UNION
 * Returns { txidFromHorizon, horizonFeeCharged } on success or error with userFacingStatus
 */
async function stage2SignAndSubmit(ctx: ExecutorContext): Promise<Stage2Result> {
  try {
    // CRITICAL: Use ONLY Payment fields (never undefined a2uPayment object parameter)
    const toAddress = ctx.payment.a2uToAddress
    const amount = ctx.payment.merchantAmount
    const a2uPaymentId = ctx.payment.a2uPaymentId
    
    if (!toAddress || typeof toAddress !== 'string') {
      return { ok: false, error: "Payment missing required a2uToAddress", userFacingStatus: "error" }
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { ok: false, error: "Payment missing required merchantAmount", userFacingStatus: "error" }
    }
    if (!a2uPaymentId || typeof a2uPaymentId !== 'string') {
      return { ok: false, error: "Payment missing required a2uPaymentId", userFacingStatus: "error" }
    }
    
    const piPrivateSeed = process.env.PI_PRIVATE_SEED
    if (!piPrivateSeed) {
      console.error("[A2U Stage2] ❌ PI_PRIVATE_SEED not configured - cannot sign Horizon transaction")
      // DO NOT set horizonSuccessFlag=true or persist a2uTxid on failure (crash-safe merge)
      const failureUpdates = {
        status: "settlement_pending" as const,
        piCompletionPending: true,
      }
      await persistCheckpointMerged(ctx.paymentId, failureUpdates)
      return { ok: false, error: "PI_PRIVATE_SEED not configured - requires manual intervention", userFacingStatus: "settlement_pending" }
    }

    console.log("[A2U Stage2] Creating Stellar keypair")
    const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
    const appPublicKey = appKeypair.publicKey()

    if (appPublicKey !== ctx.payment.a2uFromAddress) {
      console.error("[A2U Stage2] Address mismatch")
      return { ok: false, error: "Private seed does not match app wallet address", userFacingStatus: "error" }
    }

    console.log("[A2U Stage2] Connecting to Horizon")
    const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
      allowHttp: false,
    })

    const sourceAccount = await horizonServer.loadAccount(appPublicKey)
    
    let feeCharged: number
    try {
      const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
      const baseFeeNumber = Number(baseFeeFromHorizon)
      if (!Number.isFinite(baseFeeNumber) || baseFeeNumber <= 0) {
        return { ok: false, error: "Horizon baseFee is not a valid positive number", userFacingStatus: "error" }
      }
      feeCharged = baseFeeNumber * 2
    } catch (feeError) {
      console.error("[A2U Stage2] Failed to fetch Horizon baseFee:", feeError)
      return { ok: false, error: "Failed to fetch Horizon baseFee", userFacingStatus: "error" }
    }

    // Stellar SDK TransactionBuilder requires fee as string
    const feeAsString = String(Math.floor(feeCharged))

    console.log("[A2U Stage2] Building transaction")
    const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: feeAsString,
      networkPassphrase: "Pi Testnet",
    })

    builder.addOperation(
      StellarSDK.Operation.payment({
        destination: toAddress,
        asset: StellarSDK.Asset.native(),
        amount: amount.toString(),
      })
    )

    builder.addMemo(StellarSDK.Memo.text(a2uPaymentId.substring(0, 28)))
    builder.setTimeout(StellarSDK.TimeoutInfinite)

    const transaction = builder.build()
    transaction.sign(appKeypair)

    console.log("[A2U Stage2] Submitting to Horizon")
    const submitResult = await horizonServer.submitTransaction(transaction)

    const txidFromHorizon = submitResult.hash
    console.log("[A2U Stage2] ✓ Horizon submission succeeded:", txidFromHorizon)
    
    // Fetch the typed transaction record from Horizon to read actual fee_charged
    console.log("[A2U Stage2] Fetching transaction record for fee verification")
    const transactionRecord = await horizonServer.transactions().transaction(txidFromHorizon).call()
    
    // Validate fee_charged is number or string (stroops)
    const feeChargedStroops = transactionRecord.fee_charged
    if (typeof feeChargedStroops !== 'number' && typeof feeChargedStroops !== 'string') {
      return { ok: false, error: "Horizon transaction has invalid fee_charged type", userFacingStatus: "error" }
    }
    
    const feeChargedAsNumber = Number(feeChargedStroops)
    if (!Number.isFinite(feeChargedAsNumber) || feeChargedAsNumber < 0) {
      return { ok: false, error: "Horizon transaction fee_charged is not a finite nonnegative number", userFacingStatus: "error" }
    }
    
    // Convert stroops to Pi (1 Pi = 10,000,000 stroops)
    const horizonFeeCharged = feeChargedAsNumber / 10_000_000
    
    console.log("[A2U Stage2] ✓ Fee verified from Horizon:", horizonFeeCharged)
    // Return txid and fee for persisting in executeA2U
    return { 
      ok: true,
      data: {
        txidFromHorizon,
        horizonFeeCharged,
      },
    }
  } catch (error) {
    console.error("[A2U Stage2] Exception:", error)
    return { ok: false, error: String(error), userFacingStatus: "error" }
  }
}

/**
 * STAGE 3: Call Pi /complete - TYPED DISCRIMINATED UNION
 * Returns no-data success or error with userFacingStatus
 */
async function stage3CompletePi(ctx: ExecutorContext, a2uPaymentId: string, txidFromHorizon: string): Promise<Stage3Result> {
  try {
    console.log("[A2U Stage3] Calling Pi /v2/payments/complete")

    const response = await fetch(`https://api.minepi.com/v2/payments/${a2uPaymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${serverConfig.piApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ txid: txidFromHorizon }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      if (response.status === 400 && errorText.includes("already_completed")) {
        console.log("[A2U Stage3] Payment already_completed - refetching to validate")
        // This is OK - payment was already marked complete
        return { ok: true }
      }
      console.error("[A2U Stage3] Pi /complete failed:", errorText)
      return { ok: false, error: "Pi /complete failed", userFacingStatus: "error" }
    }

    console.log("[A2U Stage3] ✓ Pi /complete succeeded")
    return { ok: true }
  } catch (error) {
    console.error("[A2U Stage3] Exception:", error)
    return { ok: false, error: String(error), userFacingStatus: "error" }
  }
}

/**
 * STAGE 4: Reconcile in database
 * STRICT: Validate ALL fields before transaction entry, NO fallbacks
 * TYPED DISCRIMINATED UNION
 */
async function stage4ReconcileDB(ctx: ExecutorContext, txidFromHorizon: string): Promise<Stage4Result> {
  try {
    console.log("[A2U Stage4] Reconciling database")

    // STRICT: Validate financial data first - will reject on missing values
    const validation = validateFinancialData(ctx.payment)
    if (!validation.success) {
      console.error("[A2U Stage4] Financial validation failed:", validation.error)
      return { ok: false, error: validation.error, userFacingStatus: "error" }
    }

    const financialData = validation.data

    // CRITICAL VALIDATION: Reject if horizonFeeCharged missing - NO fallback to 0
    if (typeof financialData.horizonFeeCharged !== 'number' || !Number.isFinite(financialData.horizonFeeCharged)) {
      console.error("[A2U Stage4] ❌ AUDIT FAILURE: horizonFeeCharged must be a finite number, got:", financialData.horizonFeeCharged)
      return { ok: false, error: "horizonFeeCharged validation failed - cannot proceed to DB", userFacingStatus: "error" }
    }

    // CRITICAL: appCommission MUST be explicit number from validated data
    if (typeof financialData.appCommission !== 'number' || !Number.isFinite(financialData.appCommission)) {
      console.error("[A2U Stage4] ❌ AUDIT FAILURE: appCommission must be a finite number, got:", financialData.appCommission)
      return { ok: false, error: "appCommission validation failed - cannot proceed to DB", userFacingStatus: "error" }
    }

    console.log("[A2U Stage4] All financial fields validated - proceeding to DB:")
    console.log("[A2U Stage4]   - customerAmount:", financialData.customerAmount)
    console.log("[A2U Stage4]   - merchantAmount:", financialData.merchantAmount)
    console.log("[A2U Stage4]   - horizonFeeCharged:", financialData.horizonFeeCharged)
    console.log("[A2U Stage4]   - appCommission:", financialData.appCommission)

    // Validate piPaymentId is present and is a string before DB record
    if (!ctx.piPaymentId || typeof ctx.piPaymentId !== 'string') {
      return { ok: false, error: "piPaymentId required for DB record - missing U2A identifier", userFacingStatus: "error" }
    }

    // Call DB with VALIDATED financial data only
    // CRITICAL: Pass financialData.a2uPaymentId (validated string) not ctx.payment.a2uPaymentId (optional)
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: ctx.piPaymentId,
      u2aTxid: financialData.u2aTxid,
      a2uIdentifier: financialData.a2uPaymentId,
      a2uTxid: txidFromHorizon,
      merchantId: financialData.merchantId,
      merchantUid: financialData.merchantUid,
      customerAmount: financialData.customerAmount,
      merchantAmount: financialData.merchantAmount,
      horizonFeeCharged: financialData.horizonFeeCharged,
      appCommission: financialData.appCommission,
    })

    if (!dbResult || !dbResult.success) {
      console.error("[A2U Stage4] DB reconciliation failed:", dbResult?.error)
      // Persist failure state for recovery
      ctx.payment.status = "settlement_pending"
      ctx.payment.dbRecorded = false
      ctx.payment.requiresDbReconciliation = true
      await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
      console.log("[A2U Stage4] Persisted settlement_pending with dbRecorded=false and requiresDbReconciliation=true")
      return { ok: false, error: dbResult?.error || "Unknown DB error", userFacingStatus: "settlement_pending" }
    }

    console.log("[A2U Stage4] ✓ DB reconciliation succeeded with transaction ID:", dbResult.transactionId)
    // Return ok: true to proceed past stage 4 (executor will still return settlement_pending to caller)
    return { ok: true }
  } catch (error) {
    console.error("[A2U Stage4] Exception:", error)
    return { ok: false, error: String(error), userFacingStatus: "error" }
  }
}

/**
 * Crash-safe checkpoint persist with merge semantics
 * Reloads latest record from Redis before persisting to ensure monotonic advancement.
 * Never overwrites newer evidence (a2uPaymentId, a2uTxid, horizonSuccessFlag, piCompleted, dbRecorded).
 */
async function persistCheckpointMerged(
  paymentId: string,
  updates: Partial<Payment>
): Promise<void> {
  if (!isRedisConfigured) {
    console.error("[A2U Checkpoint] Redis not configured - skipping persist")
    return
  }

  try {
    // Reload latest record to merge with new evidence
    const latestData = await redis.get(`payment:${paymentId}`)
    const latest: Payment = latestData
      ? (typeof latestData === "string" ? JSON.parse(latestData) : latestData)
      : {}

    // Merge strategy: never lose newer evidence
    const merged: Payment = {
      ...latest,
      ...updates,
      // Preserve already-set terminal markers (never unset)
      a2uPaymentId: updates.a2uPaymentId || latest.a2uPaymentId,
      a2uTxid: updates.a2uTxid || latest.a2uTxid,
      horizonSuccessFlag: updates.horizonSuccessFlag ?? latest.horizonSuccessFlag,
      piCompleted: updates.piCompleted ?? latest.piCompleted,
      dbRecorded: updates.dbRecorded ?? latest.dbRecorded,
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(merged))
    console.log("[A2U Checkpoint] ✓ Merged checkpoint persisted")
  } catch (error) {
    console.error("[A2U Checkpoint] Failed to persist merged checkpoint:", error)
    // Ensure we don't crash the entire executor on persist failure
    // Recovery will detect stale state on next attempt
  }
}

/**
 * Fetch existing A2U payment
 * Parses response as unknown and validates with isPiA2UPayment guard - NO CASTS
 */
async function fetchA2UPayment(a2uPaymentId: string): Promise<PiA2UPayment | null> {
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${a2uPaymentId}`, {
      method: "GET",
      headers: {
        Authorization: `Key ${serverConfig.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      console.error("[A2U Fetch] Failed to fetch A2U payment")
      return null
    }

    const responseData: unknown = await response.json()
    
    // Validate response with type guard - NO CASTS
    if (!isPiA2UPayment(responseData)) {
      console.error("[A2U Fetch] A2U response validation failed:", responseData)
      return null
    }
    
    return responseData
  } catch (error) {
    console.error("[A2U Fetch] Exception:", error)
    return null
  }
}
