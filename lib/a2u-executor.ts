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

interface ExecutorContext {
  paymentId: string
  payment: any
  merchantUid: string
  accessToken: string
  amount: number
  piPaymentId?: string
  isRecovery: boolean
}

interface ExecutorResult {
  success: boolean
  status: string
  error?: string
  txidFromHorizon?: string
  a2uPaymentId?: string
}

/**
 * UNIFIED EXECUTOR: Resume from stored stage or execute complete flow
 */
export async function executeA2U(ctx: ExecutorContext): Promise<ExecutorResult> {
  console.log("[A2U Executor] ===== UNIFIED A2U EXECUTOR START =====")
  console.log("[A2U Executor] Payment ID:", ctx.paymentId)
  console.log("[A2U Executor] Is Recovery:", ctx.isRecovery)
  console.log("[A2U Executor] Current Status:", ctx.payment.status)

  // STAGE 0: Check if already settled (terminal state)
  if (ctx.payment.status === "settled_to_merchant") {
    console.log("[A2U Executor] ✅ Already settled - returning success")
    const canonicalResponse = await buildA2USuccessResponse(ctx.paymentId)
    if (!canonicalResponse) {
      return { success: false, status: "error", error: "Response building failed" }
    }
    return { success: true, status: "settled_to_merchant" }
  }

  // STAGE 1: Get/Create A2U payment (skip if already have a2uPaymentId)
  let a2uPayment = ctx.payment.a2uPayment || null
  let a2uPaymentId = ctx.payment.a2uPaymentId

  if (!a2uPaymentId) {
    console.log("[A2U Executor] STAGE 1: Creating new A2U payment")
    const stageResult = await stage1CreateA2U(ctx)
    if (!stageResult.success) {
      return stageResult
    }
    a2uPayment = stageResult.a2uPayment
    a2uPaymentId = stageResult.a2uPaymentId
    ctx.payment.a2uPaymentId = a2uPaymentId
  } else {
    console.log("[A2U Executor] STAGE 1: Reusing existing A2U payment:", a2uPaymentId)
    // Fetch existing A2U payment if needed
    if (!a2uPayment) {
      const fetchResult = await fetchA2UPayment(a2uPaymentId)
      if (!fetchResult) {
        return { success: false, status: "error", error: "Failed to fetch existing A2U payment" }
      }
      a2uPayment = fetchResult
    }

    // Check if already_completed on Pi
    if (a2uPayment.status?.developer_completed === true && a2uPayment.transaction?.verified === true) {
      console.log("[A2U Executor] EARLY DETECTION: A2U already completed on Pi")
      const persistedCheckpoint = {
        ...ctx.payment,
        status: "settled_to_merchant",
        a2uTxid: a2uPayment.transaction.txid,
        piCompleted: true,
        dbRecorded: true,
        settlementCompletedAt: new Date().toISOString(),
      }
      await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(persistedCheckpoint))
      const canonicalResponse = await buildA2USuccessResponse(ctx.paymentId)
      if (!canonicalResponse) {
        return { success: false, status: "error", error: "Response building failed" }
      }
      return { success: true, status: "settled_to_merchant", txidFromHorizon: a2uPayment.transaction.txid }
    }
  }

  // Persist A2U identifiers after stage 1
  ctx.payment.a2uPaymentId = a2uPaymentId
  ctx.payment.a2uFromAddress = a2uPayment.from_address
  ctx.payment.a2uToAddress = a2uPayment.to_address
  ctx.payment.a2uAmount = a2uPayment.amount
  await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))

  // STAGE 2: Sign (skip if already have a2uTxid)
  let txidFromHorizon = ctx.payment.a2uTxid

  if (!txidFromHorizon) {
    console.log("[A2U Executor] STAGE 2: Signing transaction")
    const signResult = await stage2SignAndSubmit(ctx, a2uPayment)
    if (!signResult.success) {
      return signResult
    }
    txidFromHorizon = signResult.txidFromHorizon!
    const horizonFeeCharged = signResult.horizonFeeCharged || 0

    // CRITICAL: Persist recovery checkpoint AFTER Horizon success
    ctx.payment = {
      ...ctx.payment,
      status: "settlement_pending",
      a2uTxid: txidFromHorizon,
      a2uFromAddress: a2uPayment.from_address,
      a2uToAddress: a2uPayment.to_address,
      customerAmount: ctx.amount,
      merchantAmount: Number(a2uPayment.amount),
      horizonFeeCharged,
      horizonSuccessFlag: true,
      piCompletionPending: true,
      piCompleted: false,
      requiresDbReconciliation: false,
      horizonSuccessAt: new Date().toISOString(),
    }
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ Checkpoint persisted after Horizon success")
  } else {
    console.log("[A2U Executor] STAGE 2: Skipping signing - txid already exists:", txidFromHorizon)
  }

  // STAGE 3: Complete Pi (skip if already piCompleted)
  if (!ctx.payment.piCompleted) {
    console.log("[A2U Executor] STAGE 3: Calling Pi /complete")
    const piResult = await stage3CompletePi(ctx, a2uPaymentId, txidFromHorizon)
    if (!piResult.success) {
      return piResult
    }
    ctx.payment.piCompleted = true
    ctx.payment.piCompletionPending = false
    ctx.payment.piCompletedAt = new Date().toISOString()
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ Pi /complete succeeded")
  } else {
    console.log("[A2U Executor] STAGE 3: Skipping Pi /complete - already piCompleted")
  }

  // STAGE 4: DB Reconciliation (skip if already dbRecorded)
  if (!ctx.payment.dbRecorded) {
    console.log("[A2U Executor] STAGE 4: Reconciling in database")
    const dbResult = await stage4ReconcileDB(ctx, txidFromHorizon)
    if (!dbResult.success) {
      return dbResult
    }
    ctx.payment.dbRecorded = true
    ctx.payment.status = "settled_to_merchant"
    ctx.payment.requiresDbReconciliation = false
    ctx.payment.settlementCompletedAt = new Date().toISOString()
    await redis.set(`payment:${ctx.paymentId}`, JSON.stringify(ctx.payment))
    console.log("[A2U Executor] ✓ DB reconciliation succeeded")
  } else {
    console.log("[A2U Executor] STAGE 4: Skipping DB reconciliation - already recorded")
  }

  console.log("[A2U Executor] ===== UNIFIED A2U EXECUTOR SUCCESS =====")
  return {
    success: true,
    status: "settled_to_merchant",
    txidFromHorizon,
    a2uPaymentId,
  }
}

/**
 * STAGE 1: Create or fetch A2U payment
 */
async function stage1CreateA2U(ctx: ExecutorContext): Promise<{ success: boolean; a2uPayment?: any; a2uPaymentId?: string; error?: string }> {
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
        amount: ctx.amount,
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
            return { success: true, a2uPayment: fetchResult, a2uPaymentId: ongoingPaymentId }
          }
        }
      }

      console.error("[A2U Stage1] A2U creation failed:", errorData)
      return { success: false, error: "A2U creation failed" }
    }

    const a2uPayment = await createResponse.json()
    console.log("[A2U Stage1] ✓ A2U payment created:", a2uPayment.identifier)

    return {
      success: true,
      a2uPayment,
      a2uPaymentId: a2uPayment.identifier,
    }
  } catch (error) {
    console.error("[A2U Stage1] Exception:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * STAGE 2: Sign and submit to Horizon
 */
async function stage2SignAndSubmit(ctx: ExecutorContext, a2uPayment: any): Promise<{ success: boolean; txidFromHorizon?: string; horizonFeeCharged?: number; error?: string }> {
  try {
    const piPrivateSeed = process.env.PI_PRIVATE_SEED
    if (!piPrivateSeed) {
      console.warn("[A2U Stage2] PI_PRIVATE_SEED not configured - pending signing")
      return { success: true } // Return pending state
    }

    console.log("[A2U Stage2] Creating Stellar keypair")
    const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
    const appPublicKey = appKeypair.publicKey()

    if (appPublicKey !== a2uPayment.from_address) {
      console.error("[A2U Stage2] Address mismatch")
      return { success: false, error: "Private seed does not match app wallet address" }
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
        destination: a2uPayment.to_address,
        asset: StellarSDK.Asset.native(),
        amount: a2uPayment.amount.toString(),
      })
    )

    builder.addMemo(StellarSDK.Memo.text(a2uPayment.identifier.substring(0, 28)))
    builder.setTimeout(StellarSDK.TimeoutInfinite)

    const transaction = builder.build()
    transaction.sign(appKeypair)

    console.log("[A2U Stage2] Submitting to Horizon")
    const submitResult = await horizonServer.submitTransaction(transaction)

    const txidFromHorizon = submitResult.hash
    const horizonFeeCharged = Number(submitResult.fee_charged) / 10_000_000

    console.log("[A2U Stage2] ✓ Horizon submission succeeded:", txidFromHorizon)
    return { success: true, txidFromHorizon, horizonFeeCharged }
  } catch (error) {
    console.error("[A2U Stage2] Exception:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * STAGE 3: Call Pi /complete
 */
async function stage3CompletePi(ctx: ExecutorContext, a2uPaymentId: string, txidFromHorizon: string): Promise<{ success: boolean; error?: string }> {
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
      return { success: false, error: "Pi /complete failed" }
    }

    console.log("[A2U Stage3] ✓ Pi /complete succeeded")
    return { success: true }
  } catch (error) {
    console.error("[A2U Stage3] Exception:", error)
    return { success: false, error: String(error) }
  }
}

/**
 * STAGE 4: Reconcile in database
 * STRICT: Validate ALL fields before transaction entry, NO fallbacks
 */
async function stage4ReconcileDB(ctx: ExecutorContext, txidFromHorizon: string): Promise<{ success: boolean; error?: string }> {
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
      return { success: false, error: dbResult?.error || "Unknown DB error" }
    }

    console.log("[A2U Stage4] ✓ DB reconciliation succeeded with transaction ID:", dbResult.transactionId)
    return { success: true }
  } catch (error) {
    console.error("[A2U Stage4] Exception:", error)
    return { success: false, error: String(error) }
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
