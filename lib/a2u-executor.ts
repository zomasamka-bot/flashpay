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
type ExecutorResult = {
  success: false
  status: string
  error: string
}

/**
 * UNIFIED EXECUTOR: Resume from stored stage or execute complete flow
 * Validates all context inputs and returns discriminated union (success must include txidFromHorizon)
 */
export async function executeA2U(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Validate required context fields - no optional coercion
  if (!ctx.paymentId || typeof ctx.paymentId !== 'string') {
    return { success: false, status: "invalid_context", error: "paymentId required and must be string" }
  }
  if (!ctx.payment || typeof ctx.payment !== 'object') {
    return { success: false, status: "invalid_context", error: "payment object required" }
  }
  if (!ctx.merchantUid || typeof ctx.merchantUid !== 'string') {
    return { success: false, status: "invalid_context", error: "merchantUid required and must be string" }
  }
  if (!ctx.accessToken || typeof ctx.accessToken !== 'string') {
    return { success: false, status: "invalid_context", error: "accessToken required and must be string" }
  }
  if (typeof ctx.customerAmount !== 'number' || !Number.isFinite(ctx.customerAmount)) {
    return { success: false, status: "invalid_context", error: "customerAmount required and must be finite number" }
  }
  if (typeof ctx.isRecovery !== 'boolean') {
    return { success: false, status: "invalid_context", error: "isRecovery required and must be boolean" }
  }
  // piPaymentId is optional for new payments, but MUST be present for recovery or stage 4 DB recording
  // Validation below will enforce when needed

  console.log("[A2U Executor] ===== UNIFIED A2U EXECUTOR START =====")
  console.log("[A2U Executor] Payment ID:", ctx.paymentId)
  console.log("[A2U Executor] Is Recovery:", ctx.isRecovery)
  console.log("[A2U Executor] Current Status:", ctx.payment.status)

  // STAGE 0: Check if already settled (terminal state)
  // Executor returns settlement_pending; buildA2USuccessResponse() will return success: true after validating predicate
  if (ctx.payment.status === "settled_to_merchant") {
    console.log("[A2U Executor] ℹ️ Already settled - skipping execution")
    console.log("[A2U Executor] Caller will invoke buildA2USuccessResponse() to return final response with predicate check")
    return { success: false, status: "settlement_pending", error: "Already settled - final response via buildA2USuccessResponse()" }
  }

  // STAGE 1: Get/Create A2U payment (skip if already have a2uPaymentId)
  let a2uPaymentId = ctx.payment.a2uPaymentId

  if (!a2uPaymentId) {
    console.log("[A2U Executor] STAGE 1: Creating new A2U payment")
    const stageResult = await stage1CreateA2U(ctx)
    if (!stageResult.success) {
      return stageResult
    }
    // Discriminated union: success: true includes a2uPaymentId
    a2uPaymentId = stageResult.a2uPaymentId
    ctx.payment.a2uPaymentId = a2uPaymentId

    // Extract and persist Stage 1 payment data from stageResult
    if (stageResult.a2uPayment) {
      ctx.payment = {
        ...ctx.payment,
        a2uFromAddress: stageResult.a2uPayment.from_address,
        a2uToAddress: stageResult.a2uPayment.to_address,
        customerAmount: ctx.customerAmount,
        merchantAmount: Number(stageResult.a2uPayment.amount),
      }
      await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    }
  } else {
    console.log("[A2U Executor] STAGE 1: Reusing existing A2U payment:", a2uPaymentId)

    // For reused a2uPaymentId, fetch from Pi API to validate
    // This also detects early completion
    console.log("[A2U Executor] STAGE 1: Fetching and validating reused A2U from Pi API")
    const fetchedPayment = await fetchA2UPayment(a2uPaymentId)
    if (!fetchedPayment) {
      return { success: false, status: "error", error: "Failed to fetch existing A2U payment from Pi" }
    }

    // Validate identifier matches
    if (fetchedPayment.identifier !== a2uPaymentId) {
      return { success: false, status: "error", error: "A2U identifier mismatch from Pi API" }
    }
    
    // Validate amount matches customer amount
    if (!fetchedPayment.amount || Number(fetchedPayment.amount) !== ctx.customerAmount) {
      return { success: false, status: "error", error: "A2U amount mismatch" }
    }
    
    // Check if already_completed on Pi - early detection
    if (fetchedPayment.status?.developer_completed === true && fetchedPayment.transaction?.verified === true) {
      console.log("[A2U Executor] STAGE 1: Early detection - A2U already completed on Pi")
      if (!fetchedPayment.transaction || typeof fetchedPayment.transaction.txid !== 'string') {
        return { success: false, status: "error", error: "Completed A2U missing transaction txid" }
      }
      const txid = fetchedPayment.transaction.txid
      const feeData = fetchedPayment.transaction.fee_charged
      if (typeof feeData !== 'number') {
        console.warn("[A2U Executor] Completed A2U missing fee_charged")
        return { success: false, status: "settlement_pending", error: "A2U completed on Pi but missing fee data for DB record" }
      }
      // Persist with fetched data - but NEVER set dbRecorded or settled_to_merchant from Pi state alone
      ctx.payment = {
        ...ctx.payment,
        a2uTxid: txid,
        a2uFromAddress: fetchedPayment.from_address,
        a2uToAddress: fetchedPayment.to_address,
        customerAmount: ctx.customerAmount,
        merchantAmount: Number(fetchedPayment.amount),
        horizonFeeCharged: Number(feeData) / 10_000_000,
        horizonSuccessFlag: true,
        piCompleted: true,
        piCompletionPending: false,
        paidAt: new Date().toISOString(),
        status: "settlement_pending",
        // DO NOT set dbRecorded or settled_to_merchant - must wait for DB reconciliation
        requiresDbReconciliation: true,
      }
      await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
      console.log("[A2U Executor] ✓ Already-completed payment validated and stored for DB reconciliation")
      // Continue to stage 4 (DB reconciliation) - DO NOT return success yet
    }
  }

  // STAGE 2: Sign (skip if already have a2uTxid)
  let txidFromHorizon = ctx.payment.a2uTxid

  if (!txidFromHorizon) {
    console.log("[A2U Executor] STAGE 2: Signing transaction")
    const signResult = await stage2SignAndSubmit(ctx)
    if (!signResult.success) {
      return signResult
    }
    // Discriminated union: success: true includes txidFromHorizon and horizonFeeCharged
    txidFromHorizon = signResult.txidFromHorizon

    ctx.payment = {
      ...ctx.payment,
      status: "settlement_pending",
      a2uTxid: txidFromHorizon,
      // a2uFromAddress, a2uToAddress, merchantAmount already persisted in stage 1; NEVER pull from undefined a2uPayment
      customerAmount: ctx.customerAmount,
      horizonFeeCharged: signResult.horizonFeeCharged,
      horizonSuccessFlag: true,
      piCompletionPending: true,
      piCompleted: false,
      requiresDbReconciliation: false,
      horizonSuccessAt: new Date().toISOString(),
    }
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ Checkpoint persisted after Horizon success with fee:", signResult.horizonFeeCharged )
  } else {
    console.log("[A2U Executor] STAGE 2: Skipping signing - txid already exists:", txidFromHorizon)
  }

  // STAGE 3: Complete Pi (skip if already piCompleted)
  if (!ctx.payment.piCompleted) {
    console.log("[A2U Executor] STAGE 3: Calling Pi /complete")
    // Validate a2uPaymentId is present before calling Pi
    if (!a2uPaymentId || typeof a2uPaymentId !== 'string') {
      return { success: false, status: "error", error: "a2uPaymentId missing before stage 3" }
    }
    // Validate txidFromHorizon exists (required for Pi /complete)
    if (!txidFromHorizon || typeof txidFromHorizon !== 'string') {
      return { success: false, status: "error", error: "txidFromHorizon missing before stage 3 - Horizon must have succeeded" }
    }
    const piResult = await stage3CompletePi(ctx, a2uPaymentId, txidFromHorizon)
    if (!piResult.success) {
      return piResult
    }
    ctx.payment.piCompleted = true
    ctx.payment.piCompletionPending = false
    ctx.payment.paidAt = new Date().toISOString()
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ Pi /complete succeeded")
  } else {
    console.log("[A2U Executor] STAGE 3: Skipping Pi /complete - already piCompleted")
  }

  // STAGE 4: DB Reconciliation (skip if already dbRecorded)
  if (!ctx.payment.dbRecorded) {
    console.log("[A2U Executor] STAGE 4: Reconciling in database")
    // Validate txidFromHorizon exists for DB record
    if (!txidFromHorizon || typeof txidFromHorizon !== 'string') {
      return { success: false, status: "error", error: "txidFromHorizon missing before stage 4 - cannot record in DB" }
    }
    const dbResult = await stage4ReconcileDB(ctx, txidFromHorizon)
    if (!dbResult.success) {
      return dbResult
    }
    ctx.payment.dbRecorded = true
    ctx.payment.status = "settled_to_merchant"
    ctx.payment.requiresDbReconciliation = false
    ctx.payment.settledAt = new Date().toISOString()
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ DB reconciliation succeeded")
  } else {
    console.log("[A2U Executor] STAGE 4: Skipping DB reconciliation - already recorded")
  }

  // ALL executor paths return settlement_pending (never success: true here)
  // buildA2USuccessResponse() validates predicate and returns final success: true/false
  console.log("[A2U Executor] ===== STAGE 4 COMPLETE - RETURNING SETTLEMENT_PENDING =====")
  console.log("[A2U Executor] ℹ️ Executor complete; caller must invoke buildA2USuccessResponse() for final response")
  return {
    success: false,
    status: "settlement_pending",
    error: "Executor completed stages 1-4; final response via buildA2USuccessResponse()",
  }
}

/**
 * STAGE 1: Create or fetch A2U payment - STRICT DISCRIMINATED UNION
 */
async function stage1CreateA2U(ctx: ExecutorContext): Promise<
  { success: false; status: string; error: string } |
  { success: true; a2uPaymentId: string; a2uPayment: any }
> {
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
      return { success: false, error: "UID verification failed" }
    }

    const verifiedUser = await verifyResponse.json()
    if (verifiedUser.uid !== ctx.merchantUid) {
      console.error("[A2U Stage1] UID mismatch")
      return { success: false, error: "UID mismatch" }
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
            return { success: true, a2uPaymentId: ongoingPaymentId, a2uPayment: fetchResult }
          }
        }
      }

      console.error("[A2U Stage1] A2U creation failed:", errorData)
      return { success: false, status: "error", error: "A2U creation failed" }
    }

    const a2uPayment = await createResponse.json()
    console.log("[A2U Stage1] ✓ A2U payment created:", a2uPayment.identifier)

    return {
      success: true,
      a2uPaymentId: a2uPayment.identifier,
      a2uPayment,
    }
  } catch (error) {
    console.error("[A2U Stage1] Exception:", error)
    return { success: false, status: "error", error: String(error) }
  }
}

/**
 * STAGE 2: Sign and submit to Horizon - STRICT DISCRIMINATED UNION
 */
async function stage2SignAndSubmit(ctx: ExecutorContext): Promise<
  { success: false; status: string; error: string } |
  { success: true; txidFromHorizon: string; horizonFeeCharged: number }
> {
  try {
    // CRITICAL: Use ONLY Payment fields (never undefined a2uPayment object parameter)
    const toAddress = ctx.payment.a2uToAddress
    const amount = ctx.payment.merchantAmount
    const a2uPaymentId = ctx.payment.a2uPaymentId
    
    if (!toAddress || typeof toAddress !== 'string') {
      return { success: false, status: "error", error: "Payment missing required a2uToAddress" }
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { success: false, status: "error", error: "Payment missing required merchantAmount" }
    }
    if (!a2uPaymentId || typeof a2uPaymentId !== 'string') {
      return { success: false, status: "error", error: "Payment missing required a2uPaymentId" }
    }
    
    const piPrivateSeed = process.env.PI_PRIVATE_SEED
    if (!piPrivateSeed) {
      console.error("[A2U Stage2] ❌ PI_PRIVATE_SEED not configured - cannot sign Horizon transaction")
      // Persist checkpoint with no Horizon flags set
      ctx.payment.status = "settlement_pending"
      ctx.payment.piCompletionPending = true
      ctx.payment.horizonSuccessFlag = false // DO NOT set to true
      ctx.payment.a2uTxid = undefined // DO NOT set txid
      await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
      return { success: false, status: "settlement_pending", error: "PI_PRIVATE_SEED not configured - requires manual intervention" }
    }

    console.log("[A2U Stage2] Creating Stellar keypair")
    const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
    const appPublicKey = appKeypair.publicKey()

    if (appPublicKey !== ctx.payment.a2uFromAddress) {
      console.error("[A2U Stage2] Address mismatch")
      return { success: false, status: "error", error: "Private seed does not match app wallet address" }
    }

    console.log("[A2U Stage2] Connecting to Horizon")
    const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
      allowHttp: false,
    })

    const sourceAccount = await horizonServer.loadAccount(appPublicKey)
    let baseFee = 100
    let usedFee = 200

    try {
      const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
      baseFee = Number(baseFeeFromHorizon)
      usedFee = Number(baseFeeFromHorizon) * 2
    } catch (feeError) {
      console.warn("[A2U Stage2] Using fallback fee")
    }

    console.log("[A2U Stage2] Building transaction")
    const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: usedFee,
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
    const horizonFeeCharged = Number(submitResult.fee_charged) / 10_000_000

    console.log("[A2U Stage2] ✓ Horizon submission succeeded:", txidFromHorizon)
    // Return txid and fee for persisting in executeA2U
    return { 
      success: true,
      txidFromHorizon,
      horizonFeeCharged,
    }
  } catch (error) {
    console.error("[A2U Stage2] Exception:", error)
    return { success: false, status: "error", error: String(error) }
  }
}

/**
 * STAGE 3: Call Pi /complete - STRICT DISCRIMINATED UNION
 */
async function stage3CompletePi(ctx: ExecutorContext, a2uPaymentId: string, txidFromHorizon: string): Promise<
  { success: false; status: string; error: string } |
  { success: true }
> {
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
        return { success: true }
      }
      console.error("[A2U Stage3] Pi /complete failed:", errorText)
      return { success: false, status: "error", error: "Pi /complete failed" }
    }

    console.log("[A2U Stage3] ✓ Pi /complete succeeded")
    return { success: true }
  } catch (error) {
    console.error("[A2U Stage3] Exception:", error)
    return { success: false, status: "error", error: String(error) }
  }
}

/**
 * STAGE 4: Reconcile in database
 * STRICT: Validate ALL fields before transaction entry, NO fallbacks
 * STRICT DISCRIMINATED UNION: success: false must include status and error
 */
async function stage4ReconcileDB(ctx: ExecutorContext, txidFromHorizon: string): Promise<
  { success: false; status: string; error: string } |
  { success: true }
> {
  try {
    console.log("[A2U Stage4] Reconciling database")

    // STRICT: Validate financial data first - will reject on missing values
    const validation = validateFinancialData(ctx.payment)
    if (!validation.success) {
      console.error("[A2U Stage4] Financial validation failed:", validation.error)
      return { success: false, error: validation.error }
    }

    const financialData = validation.data

    // CRITICAL VALIDATION: Reject if horizonFeeCharged missing - NO fallback to 0
    if (typeof financialData.horizonFeeCharged !== 'number' || !Number.isFinite(financialData.horizonFeeCharged)) {
      console.error("[A2U Stage4] ❌ AUDIT FAILURE: horizonFeeCharged must be a finite number, got:", financialData.horizonFeeCharged)
      return { success: false, error: "horizonFeeCharged validation failed - cannot proceed to DB" }
    }

    // CRITICAL: appCommission MUST be explicit number from validated data
    if (typeof financialData.appCommission !== 'number' || !Number.isFinite(financialData.appCommission)) {
      console.error("[A2U Stage4] ❌ AUDIT FAILURE: appCommission must be a finite number, got:", financialData.appCommission)
      return { success: false, error: "appCommission validation failed - cannot proceed to DB" }
    }

    console.log("[A2U Stage4] All financial fields validated - proceeding to DB:")
    console.log("[A2U Stage4]   - customerAmount:", financialData.customerAmount)
    console.log("[A2U Stage4]   - merchantAmount:", financialData.merchantAmount)
    console.log("[A2U Stage4]   - horizonFeeCharged:", financialData.horizonFeeCharged)
    console.log("[A2U Stage4]   - appCommission:", financialData.appCommission)

    // Validate piPaymentId is present and is a string before DB record
    if (!ctx.piPaymentId || typeof ctx.piPaymentId !== 'string') {
      return { success: false, status: "error", error: "piPaymentId required for DB record - missing U2A identifier" }
    }

    // Call DB with VALIDATED financial data only
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: ctx.piPaymentId,
      u2aTxid: financialData.u2aTxid,
      a2uIdentifier: ctx.payment.a2uPaymentId,
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
      return { success: false, status: "settlement_pending", error: dbResult?.error || "Unknown DB error" }
    }

    console.log("[A2U Stage4] ✓ DB reconciliation succeeded with transaction ID:", dbResult.transactionId)
    // Return success: true to proceed past stage 4 (executor will still return settlement_pending to caller)
    return { success: true }
  } catch (error) {
    console.error("[A2U Stage4] Exception:", error)
    return { success: false, status: "error", error: String(error) }
  }
}

/**
 * Fetch existing A2U payment
 */
async function fetchA2UPayment(a2uPaymentId: string): Promise<any | null> {
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

    return await response.json()
  } catch (error) {
    console.error("[A2U Fetch] Exception:", error)
    return null
  }
}
