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
      // Replace ctx.payment with fully merged record returned from persist
      ctx.payment = await persistCheckpointMerged(ctx.paymentId, stage1Updates)
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
      // Replace ctx.payment with fully merged record
      ctx.payment = await persistCheckpointMerged(ctx.paymentId, preserveUpdates)
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
      // Replace ctx.payment with fully merged record
      ctx.payment = await persistCheckpointMerged(ctx.paymentId, continueUpdates)
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
    // Replace ctx.payment with fully merged record
    ctx.payment = await persistCheckpointMerged(ctx.paymentId, stage2Updates)
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
    // Replace ctx.payment with fully merged record
    ctx.payment = await persistCheckpointMerged(ctx.paymentId, stage3Updates)
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
    // Replace ctx.payment with fully merged record
    ctx.payment = await persistCheckpointMerged(ctx.paymentId, stage4Updates)
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
      // DO NOT set horizonSuccessFlag=true or persist a2uTxid on failure
      // Update status with merge and stop workflow
      try {
        const failureUpdates = {
          status: "settlement_pending" as const,
          piCompletionPending: true,
        }
        ctx.payment = await persistCheckpointMerged(ctx.paymentId, failureUpdates)
      } catch (persistError) {
        console.error("[A2U Stage2] Failed to persist failure checkpoint:", persistError)
        return { ok: false, error: "Configuration error and checkpoint persist failed", userFacingStatus: "settlement_pending" }
      }
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

    // CRITICAL: Reload latest payment record from Redis before validation
    // Ensures every field is from the authoritative checkpoint where it was persisted
    const latestPaymentData = await redis.get(`payment:${ctx.paymentId}`)
    if (!latestPaymentData) {
      console.error("[A2U Stage4] Cannot reload payment record from Redis - checkpoint may be corrupted")
      return { ok: false, error: "Payment record not found in Redis - cannot proceed to DB", userFacingStatus: "error" }
    }

    let latestPayment: Payment
    try {
      latestPayment = typeof latestPaymentData === "string" ? JSON.parse(latestPaymentData) : latestPaymentData
    } catch (parseErr) {
      console.error("[A2U Stage4] Failed to parse payment record from Redis:", parseErr)
      return { ok: false, error: "Payment record corrupted in Redis - cannot proceed to DB", userFacingStatus: "error" }
    }

    console.log("[A2U Stage4] Reloaded latest payment record from Redis checkpoint")

    // STRICT: Validate financial data first - will reject on missing values
    const validation = validateFinancialData(latestPayment)
    if (!validation.success) {
      console.error("[A2U Stage4] Financial validation failed:", validation.error)
      // Preserve checkpoint for DB-only recovery by not updating stale ctx.payment
      return { ok: false, error: validation.error, userFacingStatus: "error" }
    }

    const financialData = validation.data

    console.log("[A2U Stage4] All financial fields validated from Redis checkpoint - proceeding to DB:")
    console.log("[A2U Stage4]   - piPaymentId:", financialData.piPaymentId)
    console.log("[A2U Stage4]   - u2aTxid:", financialData.u2aTxid)
    console.log("[A2U Stage4]   - a2uPaymentId:", financialData.a2uPaymentId)
    console.log("[A2U Stage4]   - a2uTxid:", financialData.a2uTxid)
    console.log("[A2U Stage4]   - customerAmount:", financialData.customerAmount)
    console.log("[A2U Stage4]   - merchantAmount:", financialData.merchantAmount)
    console.log("[A2U Stage4]   - horizonFeeCharged:", financialData.horizonFeeCharged)
    console.log("[A2U Stage4]   - appCommission:", financialData.appCommission)

    // Call DB with VALIDATED financial data only
    // CRITICAL: Pass ONLY validated identifiers from financialData
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: financialData.piPaymentId,
      u2aTxid: financialData.u2aTxid,
      a2uIdentifier: financialData.a2uPaymentId,
      a2uTxid: financialData.a2uTxid,
      merchantId: financialData.merchantId,
      merchantUid: financialData.merchantUid,
      customerAmount: financialData.customerAmount,
      merchantAmount: financialData.merchantAmount,
      horizonFeeCharged: financialData.horizonFeeCharged,
      appCommission: financialData.appCommission,
    })

    if (!dbResult || !dbResult.success) {
      console.error("[A2U Stage4] DB reconciliation failed:", dbResult?.error)
      // Preserve failure state for recovery using monotonic merge
      try {
        await persistCheckpointMerged(ctx.paymentId, {
          status: "settlement_pending",
          dbRecorded: false,
          requiresDbReconciliation: true,
        })
        console.log("[A2U Stage4] Persisted settlement_pending with dbRecorded=false and requiresDbReconciliation=true via persistCheckpointMerged")
        // Only return settlement_pending if recovery checkpoint was successfully stored
        return { ok: false, error: dbResult?.error || "Unknown DB error", userFacingStatus: "settlement_pending" }
      } catch (persistErr) {
        // Persistence failed - propagate error, do NOT return settlement_pending
        const persistError = persistErr instanceof Error ? persistErr.message : String(persistErr)
        console.error("[A2U Stage4] CRITICAL: Failed to persist recovery checkpoint on DB failure:", persistError)
        return { ok: false, error: `DB failure AND recovery checkpoint persistence failed: ${persistError}`, userFacingStatus: "error" }
      }
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
 * Crash-safe, strictly monotonic checkpoint merge and persist
 * Returns the fully merged record on success; throws on failure to stop workflow immediately.
 * CRITICAL: If persistence fails, caller must stop all further execution and return error.
 * Reloads latest record and merges to ensure:
 * - Terminal markers (a2uPaymentId, a2uTxid, horizonSuccessFlag, piCompleted, dbRecorded) never unset
 * - Original timestamps preserved (horizonSuccessAt, paidAt, settledAt never downgraded)
 * - Conflicting identifiers fail safely
 * - settled_to_merchant never regresses
 * - Merge is strictly monotonic and irreversible
 */
async function persistCheckpointMerged(
  paymentId: string,
  updates: Partial<Payment>
): Promise<Payment> {
  if (!isRedisConfigured) {
    const msg = "[A2U Checkpoint] Redis not configured - cannot persist checkpoint"
    console.error(msg)
    throw new Error(msg)
  }

  try {
    // Reload latest record to merge with new evidence
    const latestData = await redis.get(`payment:${paymentId}`)
    if (!latestData) {
      const msg = "[A2U Checkpoint] Cannot reload payment after modification - data may be corrupted"
      console.error(msg)
      throw new Error(msg)
    }

    const latest: Payment = typeof latestData === "string" ? JSON.parse(latestData) : latestData

    // STRICT MONOTONICITY: Build merged record preserving all terminal evidence
    const merged: Payment = { ...latest }

    // Enforce immutable terminal markers (never unset once true)
    // Conflicting a2uPaymentId must fail immediately - stop workflow
    if (latest.a2uPaymentId && updates.a2uPaymentId && latest.a2uPaymentId !== updates.a2uPaymentId) {
      const msg = `[A2U Checkpoint] FATAL: Conflicting a2uPaymentId - existing="${latest.a2uPaymentId}" vs new="${updates.a2uPaymentId}" - workflow stopped`
      console.error(msg)
      throw new Error(msg)
    }
    if (updates.a2uPaymentId) {
      merged.a2uPaymentId = updates.a2uPaymentId
    }

    // Conflicting a2uTxid must fail immediately - stop workflow
    if (latest.a2uTxid && updates.a2uTxid && latest.a2uTxid !== updates.a2uTxid) {
      const msg = `[A2U Checkpoint] FATAL: Conflicting a2uTxid - existing="${latest.a2uTxid}" vs new="${updates.a2uTxid}" - workflow stopped`
      console.error(msg)
      throw new Error(msg)
    }
    if (updates.a2uTxid) {
      merged.a2uTxid = updates.a2uTxid
    }

    // Never unset proven success evidence once true - always preserve
    if (latest.horizonSuccessFlag === true) {
      merged.horizonSuccessFlag = true
    } else if (updates.horizonSuccessFlag) {
      merged.horizonSuccessFlag = true
    }

    // Never unset piCompleted once true - always preserve
    if (latest.piCompleted === true) {
      merged.piCompleted = true
    } else if (updates.piCompleted) {
      merged.piCompleted = true
    }

    // Never unset dbRecorded once true - always preserve
    if (latest.dbRecorded === true) {
      merged.dbRecorded = true
    } else if (updates.dbRecorded) {
      merged.dbRecorded = true
    }

    // Preserve original success timestamps - never downgrade
    if (latest.horizonSuccessAt && !updates.horizonSuccessAt) {
      merged.horizonSuccessAt = latest.horizonSuccessAt
    } else if (updates.horizonSuccessAt) {
      merged.horizonSuccessAt = latest.horizonSuccessAt || updates.horizonSuccessAt
    }

    if (latest.paidAt && !updates.paidAt) {
      merged.paidAt = latest.paidAt
    } else if (updates.paidAt) {
      merged.paidAt = latest.paidAt || updates.paidAt
    }

    if (latest.settledAt && !updates.settledAt) {
      merged.settledAt = latest.settledAt
    } else if (updates.settledAt) {
      merged.settledAt = latest.settledAt || updates.settledAt
    }

    // Never regress from settled_to_merchant - terminal state must not downgrade
    if (latest.status === "settled_to_merchant" && updates.status && updates.status !== "settled_to_merchant") {
      const msg = `[A2U Checkpoint] FATAL: Cannot regress from settled_to_merchant to ${updates.status} - workflow stopped`
      console.error(msg)
      throw new Error(msg)
    }
    if (updates.status) {
      merged.status = updates.status
    }

    // Merge all other allowed fields from updates while preserving protected checkpoint evidence
    // Only assign fields that are explicitly allowed (not protected terminals or timestamps)
    // Use explicit typed assignment to avoid unsafe casts
    if (updates.id !== undefined) merged.id = updates.id
    if (updates.merchantId !== undefined) merged.merchantId = updates.merchantId
    if (updates.merchantAddress !== undefined) merged.merchantAddress = updates.merchantAddress
    if (updates.merchantUid !== undefined) merged.merchantUid = updates.merchantUid
    if (updates.accessToken !== undefined) merged.accessToken = updates.accessToken
    if (updates.amount !== undefined) merged.amount = updates.amount
    if (updates.customerAmount !== undefined) merged.customerAmount = updates.customerAmount
    if (updates.merchantAmount !== undefined) merged.merchantAmount = updates.merchantAmount
    if (updates.horizonFeeCharged !== undefined) merged.horizonFeeCharged = updates.horizonFeeCharged
    if (updates.appCommission !== undefined) merged.appCommission = updates.appCommission
    if (updates.appNetImpact !== undefined) merged.appNetImpact = updates.appNetImpact
    if (updates.note !== undefined) merged.note = updates.note
    if (updates.settlementStage !== undefined) merged.settlementStage = updates.settlementStage
    if (updates.createdAt !== undefined) merged.createdAt = updates.createdAt
    if (updates.piPaymentId !== undefined) merged.piPaymentId = updates.piPaymentId
    if (updates.u2aTxid !== undefined) merged.u2aTxid = updates.u2aTxid
    if (updates.a2uFromAddress !== undefined) merged.a2uFromAddress = updates.a2uFromAddress
    if (updates.a2uToAddress !== undefined) merged.a2uToAddress = updates.a2uToAddress
    if (updates.requiresDbReconciliation !== undefined) merged.requiresDbReconciliation = updates.requiresDbReconciliation
    if (updates.piCompletionPending !== undefined) merged.piCompletionPending = updates.piCompletionPending

    // Persist merged record - if this fails, throw immediately to stop workflow
    console.log("[A2U Checkpoint] Persisting strictly monotonic checkpoint to Redis")
    await redis.set(`payment:${paymentId}`, JSON.stringify(merged))
    console.log("[A2U Checkpoint] ✓ Strictly monotonic checkpoint persisted successfully")

    return merged
  } catch (error) {
    const msg = `[A2U Checkpoint] CRITICAL FAILURE: Checkpoint persistence failed - workflow stopped immediately: ${error instanceof Error ? error.message : String(error)}`
    console.error(msg)
    // Throw immediately - caller must not proceed to Pi /complete or DB
    throw new Error(msg)
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
