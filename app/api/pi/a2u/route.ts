import { type NextRequest, NextResponse } from "next/server"
import { config } from "@/lib/config"
import { redis, isRedisConfigured } from "@/lib/redis"
import { recordA2UTransactionAtomic } from "@/lib/db"
import * as StellarSDK from "@stellar/stellar-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface A2UPaymentRequest {
  paymentId: string
}

/**
 * ATOMIC: Sign, submit to Horizon, checkpoint recovery state
 * CRITICAL: All three steps succeed or all fail together
 * If Horizon succeeds but checkpoint fails: return manual-review with txid, do NOT call Pi /complete
 * If checkpoint succeeds: safe to call Pi /complete
 */
async function horizonSignAndCheckpoint(
  horizonServer: any,
  transaction: any,
  a2uPayment: any,
  paymentId: string,
  payment: any,
  redis: any,
  baseFee: number,
  usedFee: number,
  customerAmount: number, // Verified U2A amount
  actualTransferredAmount: number // Actual A2U operation amount (merchantAmount)
): Promise<{
  success: boolean
  error?: string
  txidFromHorizon?: string
  horizonFeeCharged?: number
  requiresManualReview?: boolean
}> {
  console.log("[Pi A2U] ===== SHARED: SIGN/SUBMIT/CHECKPOINT =====")
  console.log("[Pi A2U] Payment ID:", paymentId)
  console.log("[Pi A2U] Customer amount (verified U2A):", customerAmount)
  console.log("[Pi A2U] Merchant amount (A2U destination):", actualTransferredAmount)
  console.log("[Pi A2U] A2U to_address (destination):", a2uPayment.to_address)
  console.log("[Pi A2U] A2U amount (actual transfer):", a2uPayment.amount)

  // STEP 3: Submit to Horizon
  console.log("[Pi A2U] Submitting signed transaction to Horizon...")
  let txidFromHorizon: string
  let submitResult: any

  try {
    submitResult = await horizonServer.submitTransaction(transaction)
    console.log("[Pi A2U] ✓ Horizon submission succeeded")
    console.log("[Pi A2U] Horizon txid:", submitResult.hash)

    txidFromHorizon = submitResult.hash
    console.log("[Pi A2U] Fee charged (stroops):", submitResult.fee_charged)
  } catch (horizonError) {
    const errorMsg = horizonError instanceof Error ? horizonError.message : String(horizonError)
    console.error("[Pi A2U] ❌ Horizon submission FAILED:", errorMsg)
    return {
      success: false,
      error: errorMsg,
    }
  }

  // CRITICAL: Persist recovery checkpoint IMMEDIATELY AFTER Horizon success
  // DO NOT proceed if persistence fails
  const horizonFeeCharged = Number(submitResult.fee_charged) / 10_000_000 // stroops to Pi

  console.log("[Pi A2U]")
  console.log("[Pi A2U] ===== CHECKPOINT: PERSISTING RECOVERY STATE AFTER HORIZON SUCCESS =====")
  console.log("[Pi A2U] This checkpoint is CRITICAL recovery state - ALL AUTHORITATIVE FINANCIAL DATA")
  console.log("[Pi A2U]   - a2uPaymentId (Pi identifier):", a2uPayment.identifier)
  console.log("[Pi A2U]   - a2uTxid (Horizon txid):", txidFromHorizon)
  console.log("[Pi A2U]   - a2uFromAddress:", transaction.source)
  console.log("[Pi A2U]   - a2uToAddress (ACTUAL destination):", a2uPayment.to_address)
  console.log("[Pi A2U]   - customerAmount (verified U2A):", customerAmount)
  console.log("[Pi A2U]   - merchantAmount (actual A2U):", actualTransferredAmount)
  console.log("[Pi A2U]   - horizonFeeCharged (Pi):", horizonFeeCharged)
  console.log("[Pi A2U]   - appCommission:", 0)
  console.log("[Pi A2U]   - appNetImpact:", customerAmount - actualTransferredAmount - horizonFeeCharged)
  console.log("[Pi A2U]   - horizonSuccessFlag: true")
  console.log("[Pi A2U]   - piCompletionPending: true")

  // Build checkpoint with ACTUAL A2U values and financial amounts
  const checkpointPayment = {
    ...payment,
    status: "settlement_pending",
    a2uPaymentId: a2uPayment.identifier,
    a2uTxid: txidFromHorizon,
    a2uFromAddress: transaction.source,
    a2uToAddress: a2uPayment.to_address, // ACTUAL destination from A2U, not payment.merchantAddress
    customerAmount, // Authoritative: verified U2A amount
    merchantAmount: actualTransferredAmount, // Authoritative: actual A2U operation amount
    horizonFeeCharged, // Authoritative: actual fee from Horizon
    appCommission: 0, // Explicit default commission
    appNetImpact: customerAmount - actualTransferredAmount - horizonFeeCharged,
    horizonSuccessAt: new Date().toISOString(),
    horizonSuccessFlag: true,
    piCompletionPending: true,
  }

  try {
    await redis.set(`payment:${paymentId}`, JSON.stringify(checkpointPayment))
    console.log("[Pi A2U] ✓ Recovery checkpoint safely persisted to Redis")
    console.log("[Pi A2U] Horizon transaction ID:", txidFromHorizon)
    console.log("[Pi A2U] Status: settlement_pending + horizonSuccessFlag=true + piCompletionPending=true")
    console.log("[Pi A2U] Now safe to call Pi /complete")

    return {
      success: true,
      txidFromHorizon,
      horizonFeeCharged,
    }
  } catch (persistError) {
    const errorMsg = persistError instanceof Error ? persistError.message : String(persistError)
    console.error("[Pi A2U] ❌ CRITICAL: Checkpoint persistence failed AFTER Horizon success")
    console.error("[Pi A2U] Error:", errorMsg)
    console.error("[Pi A2U] Horizon transaction was successful, but we cannot safely proceed")
    console.error("[Pi A2U] Must return manual-review with known txid")
    console.error("[Pi A2U] DO NOT call Pi /complete")

    return {
      success: false,
      error: "Checkpoint persistence failed after Horizon success",
      txidFromHorizon, // Return the txid we DID get from Horizon
      horizonFeeCharged,
      requiresManualReview: true,
    }
  }
}

/**
 * Verify merchantId from Pi /v2/me endpoint using access token
 * Returns the verified Pi UID (merchantId)
 */
async function verifyMerchantIdentityFromPi(accessToken: string): Promise<{ uid: string } | null> {
  try {
    const meResponse = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!meResponse.ok) {
      console.error("[Pi A2U] Failed to verify merchant identity from Pi:", meResponse.status)
      return null
    }

    const meData = await meResponse.json()
    if (!meData?.uid) {
      console.error("[Pi A2U] Pi /v2/me response missing uid")
      return null
    }

    console.log("[Pi A2U] ✓ Verified merchant identity from Pi:", meData.uid)
    return { uid: meData.uid }
  } catch (error) {
    console.error("[Pi A2U] Error verifying merchant identity:", error)
    return null
  }
}

// Strict validator for A2U payments
function validateA2UPayment(
  payment: any,
  paymentId: string,
  amount: number,
  merchantUid: string,
  expectedIdentifier: string,
  expectedTxid?: string,
  expectedFromAddress?: string,
  expectedToAddress?: string
): { valid: boolean; error?: string } {
  // Exact identifier match
  if (payment.identifier !== expectedIdentifier) {
    return { valid: false, error: `identifier mismatch: expected ${expectedIdentifier}, got ${payment.identifier}` }
  }

  // metadata.paymentId
  if (payment.metadata?.paymentId !== paymentId) {
    return { valid: false, error: `paymentId mismatch: expected ${paymentId}, got ${payment.metadata?.paymentId}` }
  }

  // Numeric amount (using Number, not parseInt)
  if (Number(payment.amount) !== amount) {
    return { valid: false, error: `amount mismatch: expected ${amount}, got ${Number(payment.amount)}` }
  }

  // Direction must be exactly "app_to_user"
  if (payment.direction !== "app_to_user") {
    return { valid: false, error: `direction mismatch: expected app_to_user, got ${payment.direction}` }
  }

  // user_uid
  if (payment.user_uid !== merchantUid) {
    return { valid: false, error: `user_uid mismatch: expected ${merchantUid}, got ${payment.user_uid}` }
  }

  // Exact from_address and to_address comparison
  if (expectedFromAddress && payment.from_address !== expectedFromAddress) {
    return { valid: false, error: `from_address mismatch: expected ${expectedFromAddress}, got ${payment.from_address}` }
  }

  if (expectedToAddress && payment.to_address !== expectedToAddress) {
    return { valid: false, error: `to_address mismatch: expected ${expectedToAddress}, got ${payment.to_address}` }
  }

  // txid must match if provided
  if (expectedTxid && payment.transaction?.txid !== expectedTxid) {
    return { valid: false, error: `txid mismatch: expected ${expectedTxid}, got ${payment.transaction?.txid}` }
  }

  // transaction.verified must be exactly true
  if (payment.transaction?.verified !== true) {
    return { valid: false, error: "transaction.verified is not true" }
  }

  // status.developer_approved must be exactly true
  if (payment.status?.developer_approved !== true) {
    return { valid: false, error: "status.developer_approved is not true" }
  }

  // status.developer_completed must be exactly true
  if (payment.status?.developer_completed !== true) {
    return { valid: false, error: "status.developer_completed is not true" }
  }

  // Both cancellation flags must be exactly false
  if (payment.status?.cancelled !== false) {
    return { valid: false, error: "status.cancelled is not false" }
  }

  if (payment.status?.user_cancelled !== false) {
    return { valid: false, error: "status.user_cancelled is not false" }
  }

  return { valid: true }
}

/**
 * ============================================================================
 * App-to-User Transfer (A2U) - Send funds to merchant wallet (INTERNAL ONLY)
 * ============================================================================
 * 
 * SECURITY: This endpoint is for internal calls only from /api/pi/complete.
 * 
 * Validates internal secret header before accepting any request.
 * Accepts ONLY paymentId; derives all A2U data from Redis payment record.
 * 
 * REQUIREMENTS:
 * 1. x-flashpay-internal-secret header must match A2U_INTERNAL_SECRET from environment
 * 2. paymentId in request body must exist in Redis
 * 3. Redis payment:${paymentId} must contain:
 *    - status: "paid_to_app" (set by /api/pi/complete after U2A verification)
 *    - piPaymentId (Pi identifier)
 *    - txid (Pi transaction)
 *    - amount > 0
 *    - merchantId
 *    - merchantUid
 *    - accessToken
 *
 * FLOW:
 * 1. Pi Wallet confirms U2A payment → client calls /api/pi/complete
 * 2. /api/pi/complete verifies payment, sets status to paid_to_app
 * 3. /api/pi/complete calls /api/pi/a2u with only paymentId + A2U_INTERNAL_SECRET
 * 4. A2U loads payment from Redis (trusts only Redis data)
 * 5. Verifies all required fields and constraints
 * 6. Calls Pi API to transfer funds to merchant wallet
 */

// POST /api/pi/a2u — Internal App-to-User payment endpoint
// Called only from /api/pi/complete with x-flashpay-internal-secret header
export async function POST(request: NextRequest) {
  console.log("[Pi A2U] App-to-User payment initiated at", new Date().toISOString())

  try {
    // Validate internal secret header with timing-safe comparison
    const providedSecret = request.headers.get("x-flashpay-internal-secret")
    
    // Fail closed if secret is missing or not a string
    if (!config.a2uInternalSecret || typeof config.a2uInternalSecret !== "string") {
      console.error("[Pi A2U] SECURITY: A2U_INTERNAL_SECRET not configured - REJECTING ALL REQUESTS")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }
    
    if (!providedSecret) {
      console.error("[Pi A2U] SECURITY: Missing x-flashpay-internal-secret header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    
    // Timing-safe comparison to prevent timing attacks
    const secretBuffer = Buffer.from(config.a2uInternalSecret)
    const providedBuffer = Buffer.from(providedSecret)
    
    if (secretBuffer.length !== providedBuffer.length || !secretBuffer.equals(providedBuffer)) {
      console.error("[Pi A2U] SECURITY: Invalid x-flashpay-internal-secret header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log("[Pi A2U] ✓ Internal secret validated")

    // Reject unauthorized calls before any other processing
    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi A2U] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    // Accept ONLY paymentId from request
    const body: A2UPaymentRequest = await request.json()
    const { paymentId } = body

    if (!paymentId) {
      console.error("[Pi A2U] Missing paymentId in request")
      return NextResponse.json({ error: "Missing paymentId" }, { status: 400 })
    }

    console.log("[Pi A2U] ===== A2U REQUEST RECEIVED =====")
    console.log("[Pi A2U] Payment ID:", paymentId)

    // CONCURRENCY: Acquire distributed lock before any Pi/Horizon/signing action
    if (!isRedisConfigured) {
      console.error("[Pi A2U] Redis not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    const lockToken = crypto.randomUUID()
    const lockKey = `a2u:lock:${paymentId}`
    const lockTtl = 600 // 10 minutes

    console.log("[Pi A2U] ===== ACQUIRING CONCURRENCY LOCK =====")
    
    let lockAcquired = false
    try {
      // Try to acquire lock with SET NX EX
      const lockResult = await redis.set(lockKey, lockToken, { nx: true, ex: lockTtl })
      lockAcquired = lockResult === "OK"
    } catch (lockError) {
      console.error("[Pi A2U] Lock acquisition error:", lockError)
    }

    if (!lockAcquired) {
      console.warn("[Pi A2U] ⚠️  Could not acquire lock - another A2U may be in progress")
      console.log("[Pi A2U] Re-reading payment records to check if already complete...")
      
      // Re-read both records to check if already complete
      const paymentCheck = await redis.get(`payment:${paymentId}`)
      const a2uCheck = await redis.get(`a2u:${paymentId}`)
      
      const payment = paymentCheck ? (typeof paymentCheck === "string" ? JSON.parse(paymentCheck) : paymentCheck) : null
      const a2uRecord = a2uCheck ? (typeof a2uCheck === "string" ? JSON.parse(a2uCheck) : a2uCheck) : null
      
      if (a2uRecord?.a2uStatus === "settled_to_merchant" || a2uRecord?.status === "settled_to_merchant" || payment?.a2uStatus === "settled_to_merchant" || payment?.status === "settled_to_merchant") {
        console.log("[Pi A2U] Payment already settled - returning 200 without transfer")
        // Return exact stored success response at top level
        if (a2uRecord?.success !== undefined) {
          return NextResponse.json(a2uRecord)
        }
        return NextResponse.json({ success: true, message: "Payment already settled" })
      }
      
      console.error("[Pi A2U] Lock unavailable and payment not complete - cannot proceed")
      return NextResponse.json({ error: "A2U transfer in progress" }, { status: 409 })
    }

    console.log("[Pi A2U] ✓ Lock acquired:", lockKey)

    // Helper: Atomic Lua-based lock release (compare-and-delete by token)
    // THIS FUNCTION MUST BE CALLED EXACTLY ONCE FROM finally
    const releaseLockAtomic = async () => {
      if (!isRedisConfigured) return
      try {
        const luaScript = `
          if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
          else
            return 0
          end
        `
        await redis.eval(luaScript, [lockKey], [lockToken])
      } catch (error) {
        console.warn("[Pi A2U] Failed to release lock atomically:", error)
      }
    }

    try {
      // Re-read both records after lock acquisition
      const paymentData = await redis.get(`payment:${paymentId}`)
      const a2uData = await redis.get(`a2u:${paymentId}`)
      
      if (!paymentData) {
        console.error("[Pi A2U] Payment not found in Redis:", paymentId)
        return NextResponse.json({ error: "Payment not found" }, { status: 404 })
      }

      let payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
      let a2uRecord = a2uData ? (typeof a2uData === "string" ? JSON.parse(a2uData) : a2uData) : null
      
      // Check if already complete after re-read
      if (a2uRecord?.a2uStatus === "settled_to_merchant" || a2uRecord?.status === "settled_to_merchant" || payment?.a2uStatus === "settled_to_merchant" || payment?.status === "settled_to_merchant") {
        console.log("[Pi A2U] Payment already settled after lock - returning 200 without transfer")
        // Return exact stored success response at top level
        if (a2uRecord?.success !== undefined) {
          return NextResponse.json(a2uRecord)
        }
        return NextResponse.json({ success: true, message: "Payment already settled" })
      }
      
      console.log("[Pi A2U] ✓ Payment loaded from Redis after lock")

    // === RECOVERY CHECKS MUST RUN BEFORE STATUS VALIDATION ===
    // Recovery logic must be reachable for settlement_pending and requiresDbReconciliation states
    
    console.log("[Pi A2U] === CHECKING RECOVERY STATES ===")
    console.log("[Pi A2U] Current status:", payment.status)
    console.log("[Pi A2U] Has a2uPaymentId:", !!payment.a2uPaymentId)
    console.log("[Pi A2U] Has a2uTxid:", !!payment.a2uTxid)
    console.log("[Pi A2U] requiresDbReconciliation:", payment.requiresDbReconciliation)
    
    // Recovery: settled_to_merchant - payment is already final
    if (payment.status === "settled_to_merchant" || payment.a2uStatus === "settled_to_merchant") {
      console.log("[Pi A2U] RECOVERY: Payment already settled_to_merchant")
      return NextResponse.json({
        success: true,
        message: "Payment already settled_to_merchant",
        status: "settled_to_merchant",
      })
    }

    // Recovery: settlement_pending with A2U identifiers - reuse the stored transfer
    if (payment.status === "settlement_pending" && payment.a2uPaymentId && payment.a2uTxid) {
      console.log("[Pi A2U] RECOVERY: settlement_pending with stored A2U identifiers")
      console.log("[Pi A2U] Reusing a2uPaymentId:", payment.a2uPaymentId)
      console.log("[Pi A2U] Reusing a2uTxid:", payment.a2uTxid)
      console.log("[Pi A2U] SKIPPING Horizon - returning stored transaction identifiers")
      
      // Return success with stored identifiers - no blockchain resubmission
      return NextResponse.json({
        success: true,
        message: "Idempotent recovery - reusing stored A2U transfer",
        a2uPaymentId: payment.a2uPaymentId,
        txid: payment.a2uTxid,
        feeCharged: payment.horizonFeeCharged || 0,
        fromAddress: payment.a2uFromAddress,
        toAddress: payment.a2uToAddress,
      }, { status: 200 })
    }

    // Recovery: requiresDbReconciliation - A2U succeeded on Horizon, DB call failed
    // Must NOT retry Horizon, only retry database persistence
    if (payment.requiresDbReconciliation && payment.a2uTxid) {
      console.log("[Pi A2U] RECOVERY: requiresDbReconciliation with stored A2U txid")
      console.log("[Pi A2U] Stored a2uTxid:", payment.a2uTxid)
      console.log("[Pi A2U] This is a DB-only retry - calling recordA2UTransactionAtomic directly")
      
      // Import and call the DB reconciliation function directly
      const { recordA2UTransactionAtomic } = await import("@/lib/transaction-pg-service")
      
      const dbResult = await recordA2UTransactionAtomic({
        u2aIdentifier: payment.piPaymentId,
        u2aTxid: payment.txid,
        a2uIdentifier: payment.a2uPaymentId,
        a2uTxid: payment.a2uTxid,
        merchantId: payment.merchantId,
        merchantUid: payment.merchantUid,
        customerAmount: payment.amount,
        merchantAmount: payment.merchantAmount || payment.amount,
        horizonFeeCharged: payment.horizonFeeCharged || 0,
        appCommission: payment.appCommission || 0,
      })
      
      if (dbResult.success) {
        console.log("[Pi A2U] RECOVERY: DB reconciliation succeeded")
        // Update payment to settled_to_merchant
        const settledPayment = {
          ...payment,
          status: "settled_to_merchant",
          settlementCompletedAt: new Date().toISOString(),
        }
        await redis.set(`payment:${paymentId}`, JSON.stringify(settledPayment))
        
        return NextResponse.json({
          success: true,
          message: "DB reconciliation completed",
          status: "settled_to_merchant",
          a2uPaymentId: payment.a2uPaymentId,
          txid: payment.a2uTxid,
        })
      } else {
        console.error("[Pi A2U] RECOVERY: DB reconciliation failed:", dbResult.error)
        return NextResponse.json({
          success: false,
          error: dbResult.error,
          message: "DB reconciliation failed",
          requiresManualReview: true,
        }, { status: 500 })
      }
    }

    // === NOW VALIDATE STATUS FOR NORMAL FLOW ===
    // Validate payment record structure and all required fields
    if (payment.id !== paymentId) {
      console.error("[Pi A2U] SECURITY: Payment ID mismatch in record")
      return NextResponse.json({ error: "Payment validation failed" }, { status: 400 })
    }

    if (payment.status !== "paid_to_app") {
      console.error("[Pi A2U] Payment status is not paid_to_app and not in recovery:", payment.status)
      return NextResponse.json({ error: "Payment not marked as paid_to_app and not recoverable" }, { status: 400 })
    }

    if (!payment.piPaymentId) {
      console.error("[Pi A2U] Missing piPaymentId in Redis record")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.txid) {
      console.error("[Pi A2U] Missing txid in Redis record")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.amount || payment.amount <= 0) {
      console.error("[Pi A2U] Invalid payment amount:", payment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    if (!payment.merchantId) {
      console.error("[Pi A2U] Missing merchantId in Redis record")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.merchantUid) {
      console.error("[Pi A2U] Missing merchantUid in Redis record")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.accessToken) {
      console.error("[Pi A2U] Missing accessToken in Redis record")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    // Derive all A2U data from Redis payment record - never trust request fields or pi:payment:*
    const merchantId = payment.merchantId
    const merchantUid = payment.merchantUid
    const accessToken = payment.accessToken
    const amount = payment.amount
    const memo = payment.note || "Payment settlement"

    // ===== ENVIRONMENT VERIFICATION =====
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== ENVIRONMENT VERIFICATION =====")
    console.log("[Pi A2U] PI_API_KEY loaded:", config.piApiKey ? "YES" : "NO")
    if (config.piApiKey) {
      console.log("[Pi A2U] PI_API_KEY first 8 chars:", config.piApiKey.substring(0, 8))
      console.log("[Pi A2U] PI_API_KEY last 8 chars:", config.piApiKey.substring(config.piApiKey.length - 8))
      console.log("[Pi A2U] PI_API_KEY length:", config.piApiKey.length)
    } else {
      console.error("[Pi A2U] ❌ PI_API_KEY IS NOT CONFIGURED!")
    }
    console.log("[Pi A2U] API base URL: https://api.minepi.com")
    console.log("[Pi A2U] Environment: Production (Testnet support via app credentials)")
    console.log("[Pi A2U] App URL: " + config.appUrl)
    console.log("[Pi A2U]")

    // Validate required fields
    if (!merchantUid || merchantUid.trim() === "") {
      console.error("[Pi A2U] ❌ CRITICAL: Merchant UID is empty - cannot send funds")
      console.error("[Pi A2U] Request was:", JSON.stringify(body))
      return NextResponse.json(
        { error: "Merchant UID is required for fund transfer", success: false },
        { status: 400 }
      )
    }

    if (!accessToken || accessToken.trim() === "") {
      console.error("[Pi A2U] ❌ CRITICAL: accessToken is missing - cannot verify UID")
      return NextResponse.json(
        { error: "accessToken is required to verify UID", success: false },
        { status: 400 }
      )
    }

    // ===== CRITICAL: Verify UID with Pi /v2/me before A2U createPayment =====
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== VERIFYING UID WITH PI /V2/ME BEFORE CREATEPAYMENT =====")
    console.log("[Pi A2U] Payment ID:", paymentId)
    console.log("[Pi A2U] Merchant UID to verify:", merchantUid)
    
    let verifyResponse
    try {
      verifyResponse = await fetch("https://api.minepi.com/v2/me", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      })
      
      console.log("[Pi A2U] /v2/me HTTP Status:", verifyResponse.status, verifyResponse.statusText)
    } catch (verifyError) {
      console.error("[Pi A2U] ❌ /v2/me verification fetch exception")
      console.error("[Pi A2U] Error:", verifyError instanceof Error ? verifyError.message : String(verifyError))
      return NextResponse.json(
        {
          error: "Failed to verify uid with Pi Network",
          details: verifyError instanceof Error ? verifyError.message : String(verifyError),
          step: "verify_uid",
          success: false,
        },
        { status: 500 }
      )
    }

    if (!verifyResponse.ok) {
      const verifyError = await verifyResponse.text()
      console.error("[Pi A2U] ❌ /v2/me verification FAILED")
      console.error("[Pi A2U] HTTP Status:", verifyResponse.status)
      console.error("[Pi A2U] Error Response:", verifyError)
      return NextResponse.json(
        {
          error: "UID verification failed - accessToken may be invalid or expired",
          details: verifyError,
          piStatus: verifyResponse.status,
          step: "verify_uid",
          success: false,
        },
        { status: verifyResponse.status }
      )
    }

    const verifiedUser = await verifyResponse.json()
    console.log("[Pi A2U] ✓ /v2/me verification SUCCEEDED")
    console.log("[Pi A2U] ===== FRESH /V2/ME RESPONSE AT A2U TIME =====")
    console.log(JSON.stringify(verifiedUser, null, 2))
    console.log("[Pi A2U] ===== END FRESH /V2/ME RESPONSE =====")
    
    // CRITICAL: Compare the fresh /v2/me response with the UID we're about to use
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== ACCESSTOKEN VALIDITY CHECK AT A2U TIME =====")
    console.log("[Pi A2U] accessToken provided to A2U endpoint:", accessToken ? "YES" : "NO")
    console.log("[Pi A2U] accessToken validity (via /v2/me response): VALID - returned 200")
    console.log("[Pi A2U] Fresh /v2/me app_id:", verifiedUser.app_id || "NOT PROVIDED")
    console.log("[Pi A2U] Fresh /v2/me uid:", verifiedUser.uid)
    console.log("[Pi A2U] Fresh /v2/me username:", verifiedUser.username)
    console.log("[Pi A2U]")
    console.log("[Pi A2U] NOTE: This is the CURRENT user context in Pi Browser at A2U execution time")
    console.log("[Pi A2U] NOTE: The fresh UID should match what was stored at payment creation")
    console.log("[Pi A2U] NOTE: If they don't match, the user context changed between payment creation and A2U")
    
    // Log app context from /v2/me response
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== APP CONTEXT FROM /V2/ME =====")
    console.log("[Pi A2U] User app_id:", verifiedUser.app_id || "NOT PROVIDED IN RESPONSE")
    console.log("[Pi A2U] User uid:", verifiedUser.uid)
    console.log("[Pi A2U] User username:", verifiedUser.username)
    console.log("[Pi A2U] Credentials scopes:", verifiedUser.scopes)
    console.log("[Pi A2U]")
    
    // Log API key app context - this should match the /v2/me app_id for A2U to work
    console.log("[Pi A2U] ===== APP_ID VERIFICATION =====")
    const meAppId = verifiedUser.app_id
    console.log("[Pi A2U] app_id from /v2/me:", meAppId || "NOT PROVIDED")
    console.log("[Pi A2U] NOTE: The app_id must match the app registered in Pi Developer Portal")
    console.log("[Pi A2U] NOTE: PI_API_KEY must belong to the same app_id")
    console.log("[Pi A2U] NOTE: A2U createPayment uses PI_API_KEY, which must have A2U enabled for this app")
    console.log("[Pi A2U]")
    
    const verifiedUid = verifiedUser.uid
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== UID COMPARISON =====")
    console.log("[Pi A2U] Verified UID from /v2/me:", verifiedUid)
    console.log("[Pi A2U] Original merchantUid:", merchantUid)
    console.log("[Pi A2U] UIDs match:", verifiedUid === merchantUid)
    
    if (verifiedUid !== merchantUid) {
      console.error("[Pi A2U] ❌ CRITICAL: UID MISMATCH!")
      console.error("[Pi A2U] Verified UID from /v2/me:", verifiedUid)
      console.error("[Pi A2U] merchantUid from payment:", merchantUid)
      console.error("[Pi A2U] This suggests the UID context has changed or accessToken is from a different user")
      return NextResponse.json(
        {
          error: "UID verification failed - uid mismatch",
          details: `Verified UID (${verifiedUid}) does not match payment UID (${merchantUid})`,
          step: "uid_mismatch",
          success: false,
        },
        { status: 401 }
      )
    }
    
    console.log("[Pi A2U] ✓ UID VERIFICATION SUCCESSFUL")
    console.log("[Pi A2U] Proceeding with A2U createPayment using verified UID")
    console.log("[Pi A2U]")


    // CRITICAL: A2U payment creation - use Server API Key (NOT user accessToken)
    // Request body format per Pi documentation
    const requestBody = {
      payment: {
        amount: amount,
        memo: memo || `FlashPay settlement for ${paymentId}`,
        metadata: {
          paymentId,
          merchantId,
          type: "a2u_settlement",
          timestamp: new Date().toISOString(),
        },
        uid: merchantUid,
      },
    }
    
    console.log("[Pi A2U] ===== SENDING TO PI PRODUCTION API (A2U Creation) =====")
    console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments")
    console.log("[Pi A2U] Authorization: Key [" + config.piApiKey.substring(0, 8) + "..." + config.piApiKey.substring(config.piApiKey.length - 4) + "]")
    console.log("[Pi A2U] Content-Type: application/json")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] CRITICAL APP CONTEXT FOR A2U:")
    console.log("[Pi A2U] - PI_API_KEY must be registered in Pi Developer Portal")
    console.log("[Pi A2U] - API Key must belong to the same app as verified in /v2/me")
    console.log("[Pi A2U] - A2U must be enabled for this app in Pi settings")
    console.log("[Pi A2U] - payment.uid must be valid for this app context")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== EXACT REQUEST BODY =====")
    console.log(JSON.stringify(requestBody, null, 2))
    console.log("[Pi A2U] ===== REQUEST DETAILS =====")
    console.log("[Pi A2U] payment.amount:", requestBody.payment.amount)
    console.log("[Pi A2U] payment.memo:", requestBody.payment.memo)
    console.log("[Pi A2U] payment.uid:", requestBody.payment.uid)
    console.log("[Pi A2U] payment.uid length:", requestBody.payment.uid.length)

    let a2uPayment: any // Declare early for both new and ongoing payment flows
    let a2uResponse: any
    try {
      console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== CRITICAL: APP CONTEXT MISMATCH INVESTIGATION =====")
    console.log("[Pi A2U] User's app context (from /v2/me):")
    console.log("[Pi A2U]   - app_id:", verifiedUser.app_id || "NOT PROVIDED BY PI")
    console.log("[Pi A2U]   - uid:", verifiedUser.uid)
    console.log("[Pi A2U]   - username:", verifiedUser.username)
    console.log("[Pi A2U]")
    console.log("[Pi A2U] Server PI_API_KEY context:")
    console.log("[Pi A2U]   - PI_API_KEY configured:", config.piApiKey ? "YES" : "NO")
    console.log("[Pi A2U]   - PI_API_KEY is registered to a specific app in Pi Developer Portal")
    console.log("[Pi A2U]   - That app_id must match user's app_id from /v2/me")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] If user_not_found occurs:")
    console.log("[Pi A2U]   → user's app_id ≠ PI_API_KEY's app_id")
    console.log("[Pi A2U]   → This is an app context mismatch")
    console.log("[Pi A2U]   → Check Pi Developer Portal: is this app's API Key being used?")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] SOLUTION STEPS:")
    console.log("[Pi A2U]   1. Go to Pi Developer Portal → Your App Settings")
    console.log("[Pi A2U]   2. Find the app_id (shown as 'App ID')")
    console.log("[Pi A2U]   3. Ensure this matches the user's app_id above")
    console.log("[Pi A2U]   4. If not, either:")
    console.log("[Pi A2U]      a) Generate new API Key for the correct app, OR")
    console.log("[Pi A2U]      b) Switch to the app that matches the current PI_API_KEY")
    console.log("[Pi A2U] ===== END APP CONTEXT INVESTIGATION =====")
    console.log("[Pi A2U]")
      a2uResponse = await fetch("https://api.minepi.com/v2/payments", {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      })
      console.log("[Pi A2U] HTTP Status:", a2uResponse.status, a2uResponse.statusText)
    } catch (fetchError) {
      console.error("[Pi A2U] ❌ FETCH EXCEPTION")
      console.error("[Pi A2U] Error:", fetchError instanceof Error ? fetchError.message : String(fetchError))
      return NextResponse.json(
        {
          error: "Network error - could not reach Pi API",
          details: fetchError instanceof Error ? fetchError.message : String(fetchError),
          success: false,
        },
        { status: 500 }
      )
    }

    console.log("[Pi A2U] ===== PI API RESPONSE =====")
    if (!a2uResponse.ok) {
      const errorText = await a2uResponse.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { raw: errorText }
      }
      
      console.error("[Pi A2U] ❌ STEP 1: createPayment FAILED")
      console.error("[Pi A2U] HTTP Status:", a2uResponse.status)
      console.error("[Pi A2U] Status Text:", a2uResponse.statusText)
      console.error("[Pi A2U] Error Response:", JSON.stringify(errorData, null, 2))
      
      // CRITICAL: Log the exact UID that was rejected
      console.error("[Pi A2U]")
      console.error("[Pi A2U] ===== CRITICAL: UID STORED VS UID SENT TO A2U =====")
      console.error("[Pi A2U] UID from request body (sent by frontend/payment):", merchantUid)
      console.error("[Pi A2U] UID from fresh /v2/me (current at A2U time):", verifiedUser.uid)
      console.error("[Pi A2U] Fresh /v2/me app_id:", verifiedUser.app_id || "NOT PROVIDED")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] ===== APP_ID MISMATCH DIAGNOSIS =====")
      console.error("[Pi A2U] User is authenticated via Pi Browser under app_id:", verifiedUser.app_id || "NOT PROVIDED")
      console.error("[Pi A2U] PI_API_KEY on server is registered under app_id: UNKNOWN (registered in Pi Dev Portal)")
      console.error("[Pi A2U] createPayment uses PI_API_KEY, which is looking for this user in ITS OWN app context")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] POSSIBLE CAUSES:")
      console.error("[Pi A2U] 1. PI_API_KEY belongs to a different app than what user authenticated under")
      console.error("[Pi A2U] 2. You recently changed PI_API_KEY on Vercel but it's for a different app")
      console.error("[Pi A2U] 3. User is in App Context X, but PI_API_KEY is registered to App Context Y")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] If UIDs match but Pi still rejects:")
      console.error("[Pi A2U]   → Issue is NOT the UID itself")
      console.error("[Pi A2U]   → Issue IS the app context mismatch between:")
      console.error("[Pi A2U]       a) User's authenticated app (what /v2/me shows)")
      console.error("[Pi A2U]       b) PI_API_KEY's app (registered in Pi Dev Portal)")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] This happens when:")
      console.error("[Pi A2U]   - Pi Browser loads app under App ID 'X'")
      console.error("[Pi A2U]   - User authenticates under App ID 'X'")
      console.error("[Pi A2U]   - User's UID belongs to App ID 'X' only")
      console.error("[Pi A2U]   - BUT PI_API_KEY belongs to App ID 'Y'")
      console.error("[Pi A2U]   - So A2U createPayment (using PI_API_KEY) can't find user in App ID 'Y'")
      console.error("[Pi A2U]")
      
      // Check if there's already an ongoing payment for this user
      if (errorData.code === "ongoing_payment_found" || errorText.includes("ongoing_payment")) {
        console.warn("[Pi A2U] ⚠️  ONGOING PAYMENT DETECTED")
        console.warn("[Pi A2U] Pi is blocking new A2U creation - there's already an unfinished payment")
        console.warn("[Pi A2U] Full error response:", JSON.stringify(errorData, null, 2))
        
        // Extract the ongoing payment identifier from various possible response paths
        const ongoingPaymentId = 
          errorData.payment?.identifier ||           // Most likely: payment.identifier
          errorData.identifier ||                     // Direct identifier field
          errorData.payment_id ||                     // payment_id field
          errorData.data?.identifier ||               // Nested in data
          errorData.data?.payment?.identifier         // Deeply nested
        
        console.warn("[Pi A2U] Extracted ongoing payment identifier:", ongoingPaymentId || "EXTRACTION FAILED")
        console.warn("[Pi A2U] Full error structure for debugging:")
        console.warn("[Pi A2U]   errorData.payment:", JSON.stringify(errorData.payment))
        console.warn("[Pi A2U]   errorData.identifier:", errorData.identifier)
        console.warn("[Pi A2U]   errorData.payment_id:", errorData.payment_id)
        console.warn("[Pi A2U]   errorData.data:", JSON.stringify(errorData.data))
        
        if (ongoingPaymentId) {
          console.warn("[Pi A2U] ✅ Successfully extracted ongoing payment ID")
          console.warn("[Pi A2U] Reusing ongoing payment instead of creating new one")
          console.warn("[Pi A2U] Ongoing A2U Payment ID:", ongoingPaymentId)
          console.warn("[Pi A2U] Fetching ongoing payment details from Pi...")
          console.warn("[Pi A2U]")
          
          try {
            // Fetch the ongoing payment details from Pi API
            const getPaymentResponse = await fetch(`https://api.minepi.com/v2/payments/${ongoingPaymentId}`, {
              method: "GET",
              headers: {
                Authorization: `Key ${config.piApiKey}`,
                "Content-Type": "application/json",
              },
            })
            
            if (!getPaymentResponse.ok) {
              const getError = await getPaymentResponse.text()
              console.error("[Pi A2U] ❌ Failed to fetch ongoing payment details")
              console.error("[Pi A2U] Status:", getPaymentResponse.status)
              console.error("[Pi A2U] Error:", getError)
              
              return NextResponse.json({
                error: "Could not fetch ongoing payment details",
                piPaymentId: ongoingPaymentId,
                details: getError,
                success: false,
              }, { status: getPaymentResponse.status })
            }
            
            const ongoingPaymentDetails = await getPaymentResponse.json()
            console.log("[Pi A2U] ✓ Ongoing payment details retrieved")
            console.log("[Pi A2U] Details:", JSON.stringify(ongoingPaymentDetails, null, 2))
            console.log("[Pi A2U]")
            
            // CRITICAL: Check ongoing payment status before auto-reusing
            console.log("[Pi A2U] ===== CHECKING ONGOING PAYMENT STATUS =====")
            console.log("[Pi A2U] Payment status object:", JSON.stringify(ongoingPaymentDetails.status, null, 2))
            console.log("[Pi A2U] Created at:", ongoingPaymentDetails.created_at)
            
            // Read flags only from status object
            const statusObj = ongoingPaymentDetails.status
            const isCancelled = statusObj?.cancelled === true
            const isUserCancelled = statusObj?.user_cancelled === true
            const isDeveloperApproved = statusObj?.developer_approved === true
            
            console.log("[Pi A2U] Cancelled:", isCancelled)
            console.log("[Pi A2U] User cancelled:", isUserCancelled)
            console.log("[Pi A2U] Developer approved:", isDeveloperApproved)
            
            // Reject cancelled payments
            if (isCancelled || isUserCancelled) {
              console.error("[Pi A2U] ❌ ONGOING PAYMENT IS CANCELLED")
              console.error("[Pi A2U] Cancelled:", isCancelled)
              console.error("[Pi A2U] User cancelled:", isUserCancelled)
              console.error("[Pi A2U] This payment cannot be reused - it has been cancelled")
              
              return NextResponse.json({
                error: "Ongoing payment has been cancelled and cannot be reused",
                piPaymentId: ongoingPaymentId,
                cancelled: isCancelled,
                userCancelled: isUserCancelled,
                requiresManualIntervention: true,
                success: false,
              }, { status: 409 })
            }
            
            // Require developer approval before signing
            if (!isDeveloperApproved) {
              console.error("[Pi A2U] ❌ ONGOING PAYMENT NOT APPROVED BY DEVELOPER")
              console.error("[Pi A2U] Developer approved:", isDeveloperApproved)
              console.error("[Pi A2U] This payment cannot proceed without developer approval")
              
              return NextResponse.json({
                error: "Ongoing payment not approved by developer - cannot proceed to signing",
                piPaymentId: ongoingPaymentId,
                developerApproved: isDeveloperApproved,
                requiresManualIntervention: true,
                success: false,
              }, { status: 409 })
            }
            
            console.log("[Pi A2U] ✓ Ongoing payment status is valid - proceeding with metadata validation")
            console.log("[Pi A2U]")
            
            // CRITICAL: Validate that this ongoing payment matches the CURRENT request
            console.log("[Pi A2U] ===== VALIDATING ONGOING PAYMENT METADATA =====")
            console.log("[Pi A2U] Current request details:")
            console.log("[Pi A2U]   - paymentId (from request):", paymentId)
            console.log("[Pi A2U]   - merchantId (from request):", merchantId)
            console.log("[Pi A2U]   - uid (from request):", merchantUid)
            console.log("[Pi A2U]   - amount (from request):", amount)
            console.log("[Pi A2U]")
            console.log("[Pi A2U] Ongoing payment details:")
            console.log("[Pi A2U]   - metadata:", JSON.stringify(ongoingPaymentDetails.metadata, null, 2))
            console.log("[Pi A2U]   - amount:", ongoingPaymentDetails.amount)
            console.log("[Pi A2U]   - user_uid:", ongoingPaymentDetails.user_uid)
            console.log("[Pi A2U]   - uid:", ongoingPaymentDetails.uid)
            
            // Extract metadata from ongoing payment
            const ongoingMetadata = ongoingPaymentDetails.metadata || {}
            const ongoingPaymentIdFromMetadata = ongoingMetadata.paymentId
            const ongoingMerchantIdFromMetadata = ongoingMetadata.merchantId
            
            // Validate user_uid and amount from canonical payment, not metadata
            const metadataPaymentIdMatches = ongoingPaymentIdFromMetadata === paymentId
            const metadataMerchantIdMatches = ongoingMerchantIdFromMetadata === merchantId
            const metadataUidMatches = ongoingPaymentDetails.user_uid === merchantUid
            const amountMatches = Number(ongoingPaymentDetails.amount) === amount
            
            console.log("[Pi A2U] Validation results:")
            console.log("[Pi A2U]   - paymentId match:", metadataPaymentIdMatches, `(${ongoingPaymentIdFromMetadata} === ${paymentId})`)
            console.log("[Pi A2U]   - merchantId match:", metadataMerchantIdMatches, `(${ongoingMerchantIdFromMetadata} === ${merchantId})`)
            console.log("[Pi A2U]   - uid match:", metadataUidMatches, `(${ongoingPaymentDetails.user_uid} === ${merchantUid})`)
            console.log("[Pi A2U]   - amount match:", amountMatches, `(${ongoingPaymentDetails.amount} === ${amount})`)
            console.log("[Pi A2U]")
            
            if (!metadataPaymentIdMatches || !metadataMerchantIdMatches || !metadataUidMatches || !amountMatches) {
              console.error("[Pi A2U] ❌ ONGOING PAYMENT METADATA MISMATCH")
              console.error("[Pi A2U] This ongoing payment is for a DIFFERENT request and cannot be reused")
              console.error("[Pi A2U] Ongoing payment is STALE:")
              console.error("[Pi A2U]   - Expected paymentId:", paymentId, "but found:", ongoingPaymentIdFromMetadata)
              console.error("[Pi A2U]   - Expected merchantId:", merchantId, "but found:", ongoingMerchantIdFromMetadata)
              console.error("[Pi A2U]   - Expected uid:", merchantUid, "but found:", ongoingPaymentDetails.user_uid)
              console.error("[Pi A2U]   - Expected amount:", amount, "but found:", ongoingPaymentDetails.amount)
              console.error("[Pi A2U] This stale A2U must be marked separately and not completed as current settlement")
              
              return NextResponse.json({
                error: "Ongoing payment is for a different request - cannot reuse",
                piPaymentId: ongoingPaymentId,
                paymentIdMismatch: !metadataPaymentIdMatches,
                merchantIdMismatch: !metadataMerchantIdMatches,
                uidMismatch: !metadataUidMatches,
                amountMismatch: !amountMatches,
                expectedPaymentId: paymentId,
                foundPaymentId: ongoingPaymentIdFromMetadata,
                expectedMerchantId: merchantId,
                foundMerchantId: ongoingMerchantIdFromMetadata,
                expectedUid: merchantUid,
                foundUid: ongoingPaymentDetails.user_uid,
                expectedAmount: amount,
                foundAmount: ongoingPaymentDetails.amount,
                requiresManualReview: true,
                success: false,
              }, { status: 409 })
            }
            
            console.log("[Pi A2U] ✅ METADATA VALIDATION PASSED")
            console.log("[Pi A2U] This ongoing payment matches the current request on all fields - safe to reuse")
            console.log("[Pi A2U]")
            
            // Use the ongoing payment details to continue
            const a2uPayment = ongoingPaymentDetails
            const isOngoingPayment = true
            
            // Log payment details
            console.log("[Pi A2U] ✓ STEP 1: Using existing ongoing A2U payment")
            console.log("[Pi A2U] Payment ID:", a2uPayment.identifier)
            console.log("[Pi A2U] From address:", a2uPayment.from_address)
            console.log("[Pi A2U] To address:", a2uPayment.to_address)
            console.log("[Pi A2U] Amount:", a2uPayment.amount)
            console.log("[Pi A2U]")
            
            // EARLY DETECTION: Check if ongoing payment is already completed before signing
            if (a2uPayment.status?.developer_completed === true &&
                a2uPayment.transaction?.verified === true) {
              console.log("[Pi A2U] ⚠️  EARLY DETECTION: Ongoing payment is already completed on Pi")
              console.log("[Pi A2U] Txid:", a2uPayment.transaction?.txid)
              
              // Require non-empty transaction.txid
              const existingTxid = a2uPayment.transaction?.txid
              if (!existingTxid) {
                console.error("[Pi A2U] ❌ SECURITY: Already-completed payment has no txid")
                return NextResponse.json({
                  error: "Already-completed payment missing required txid",
                  step: "early_detection_txid",
                  success: false,
                }, { status: 400 })
              }
              
              // Use strict validator to validate it matches all requirements
              const validationResult = validateA2UPayment(
                a2uPayment,
                paymentId,
                amount,
                merchantUid,
                a2uPayment.identifier,
                existingTxid,
                a2uPayment.from_address,
                a2uPayment.to_address
              )
              if (validationResult.valid) {
                console.log("[Pi A2U] ✓ Already-completed ongoing payment fully validated")
                
                // Persist completion using existing txid - mandatory write
                if (!isRedisConfigured) {
                  console.error("[Pi A2U] ❌ CRITICAL: Redis not configured but required for persistence")
                  return NextResponse.json({
                    error: "Redis not configured - cannot persist already-completed payment",
                    step: "redis_required",
                    success: false,
                  }, { status: 500 })
                }
                
                const a2uCompleteKey = `a2u:${paymentId}`
                const a2uRecord = {
                  ...payment,
                  a2uStatus: "settled_to_merchant",
                  status: "settled_to_merchant",
                  originalPaymentId: paymentId,
                  piPaymentId: a2uPayment.identifier,
                  merchantId,
                  merchantUid,
                  amount,
                  txid: existingTxid,
                  completedAt: new Date().toISOString(),
                }
                try {
                  await redis.set(a2uCompleteKey, JSON.stringify(a2uRecord))
                  console.log("[Pi A2U] ✓ Already-completed payment persisted")
                } catch (error) {
                  console.error("[Pi A2U] ❌ CRITICAL: Failed to persist already-completed record:", error)
                  throw error
                }
                
                return NextResponse.json({
                  success: true,
                  message: "A2U transfer already completed - existing txid",
                  txid: existingTxid,
                  status: "settled_to_merchant",
                  a2uPaymentId: a2uPayment.identifier,
                })
              } else {
                console.error("[Pi A2U] ❌ Early detection validation failed:", validationResult.error)
              }
            }
            
            // Now check for private seed and proceed with signing if available
            const piPrivateSeed = process.env.PI_PRIVATE_SEED
            
            console.log("[Pi A2U] ===== PRIVATE SEED CHECK =====")
            console.log("[Pi A2U] PI_PRIVATE_SEED loaded:", piPrivateSeed ? "YES" : "NO")
            if (piPrivateSeed) {
              console.log("[Pi A2U] PI_PRIVATE_SEED length:", piPrivateSeed.length, "characters")
            }
            console.log("[Pi A2U]")
            
            if (!piPrivateSeed) {
              console.warn("[Pi A2U] ⚠️  PI_PRIVATE_SEED not configured")
              console.warn("[Pi A2U] Ongoing payment found but cannot proceed without private key")
              console.warn("[Pi A2U] Status: PENDING_SIGNING")
              
              // Do NOT write a2u record here - let finally release the lock
              
              return NextResponse.json({
                success: false,
                message: "Ongoing payment found - awaiting blockchain signing",
                status: "pending_signing",
                a2uPaymentId: ongoingPaymentId,
                amount,
                details: "PI_PRIVATE_SEED required for signing",
                timestamp: new Date().toISOString(),
              }, { status: 202 })
            }
            
            // Private seed IS available - continue with signing code for the ongoing payment
            console.log("[Pi A2U] ✅ PI_PRIVATE_SEED detected - proceeding with blockchain signing for ongoing payment")
            console.log("[Pi A2U]")
            console.log("[Pi A2U] ===== STEP 2: BLOCKCHAIN TRANSACTION SIGNING =====")
            console.log("[Pi A2U] Starting blockchain signing process...")
            console.log("[Pi A2U] Private seed length:", piPrivateSeed.length)
            console.log("[Pi A2U]")
            
            // === BEGIN SIGNING IMPLEMENTATION ===
            try {
              // Pi Network uses Stellar's testnet for testing
              const networkPassphrase = "Pi Testnet"
              
              console.log("[Pi A2U] Creating Stellar keypair from PI_PRIVATE_SEED")
              const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
              const appPublicKey = appKeypair.publicKey()
              
              console.log("[Pi A2U] App wallet address from seed:", appPublicKey)
              console.log("[Pi A2U] Verifying address matches from_address:")
              console.log("[Pi A2U]   from_address:", a2uPayment.from_address)
              console.log("[Pi A2U]   derived address:", appPublicKey)
              
              if (appPublicKey !== a2uPayment.from_address) {
                console.error("[Pi A2U] ❌ ADDRESS MISMATCH")
                console.error("[Pi A2U] The PI_PRIVATE_SEED does not match the app wallet address from Pi")
                
                return NextResponse.json({
                  error: "Private seed does not match app wallet address",
                  step: "key_derivation",
                  derivedAddress: appPublicKey,
                  expectedAddress: a2uPayment.from_address,
                  success: false,
                }, { status: 400 })
              }
              
              console.log("[Pi A2U] ✓ Address verification passed")
              
              // Get server instance for Pi Testnet
              console.log("[Pi A2U] Connecting to Pi Testnet Horizon server")
              const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
                allowHttp: false,
              })
              
              console.log("[Pi A2U] Fetching account information from Horizon")
              const sourceAccount = await horizonServer.loadAccount(appPublicKey)
              console.log("[Pi A2U] ✓ Account loaded")
              console.log("[Pi A2U] Account sequence:", sourceAccount.sequenceNumber())
              
              // CRITICAL: Fetch dynamic base fee from Horizon (not fixed BASE_FEE)
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== FETCHING DYNAMIC FEE FROM HORIZON =====")
              let baseFee: string
              let usedFee: string
              try {
                const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
                baseFee = String(baseFeeFromHorizon)
                // Use 2x base fee to ensure transaction is accepted
                usedFee = (Number(baseFeeFromHorizon) * 2).toString()
                console.log("[Pi A2U] ✓ Dynamic fee fetched from Horizon")
                console.log("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
                console.log("[Pi A2U] Using fee (2x base):", usedFee, "stroops")
              } catch (feeError) {
                console.error("[Pi A2U] ❌ Failed to fetch dynamic fee from Horizon")
                console.error("[Pi A2U] Error:", feeError instanceof Error ? feeError.message : String(feeError))
                console.error("[Pi A2U] Falling back to BASE_FEE constant")
                baseFee = String(StellarSDK.BASE_FEE)
                usedFee = (Number(StellarSDK.BASE_FEE) * 2).toString()
                console.log("[Pi A2U] Fallback base fee:", baseFee, "stroops")
                console.log("[Pi A2U] Fallback used fee:", usedFee, "stroops")
              }
              console.log("[Pi A2U]")
              
              // Build the transaction
              console.log("[Pi A2U] Building Stellar transaction")
              const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
                fee: usedFee,
                networkPassphrase: networkPassphrase,
              })
              
              // Add payment operation
              builder.addOperation(
                StellarSDK.Operation.payment({
                  destination: a2uPayment.to_address,
                  asset: StellarSDK.Asset.native(),
                  amount: a2uPayment.amount.toString(),
                })
              )
              
              // Add memo using the Pi payment identifier
              builder.addMemo(StellarSDK.Memo.text(a2uPayment.identifier.substring(0, 28)))
              
              // Set timeout
              builder.setTimeout(StellarSDK.TimeoutInfinite)
              
              const transaction = builder.build()
              console.log("[Pi A2U] ✓ Transaction built")
              console.log("[Pi A2U] Transaction hash:", transaction.hash().toString("hex"))
              
              // Sign the transaction
              console.log("[Pi A2U] Signing transaction with app private key")
              transaction.sign(appKeypair)
              console.log("[Pi A2U] ✓ Transaction signed")
              
              // Get XDR envelope
              const txEnvelope = transaction.toEnvelope().toXDR()
              const txXDR = txEnvelope.toString("base64")
              console.log("[Pi A2U] Transaction XDR generated")
              console.log("[Pi A2U] XDR length:", txXDR.length, "characters")
              
              // CRITICAL STEP 3: Submit signed XDR to Horizon/Stellar SDK to get TXID
              // This MUST be done via Horizon, not directly to Pi API
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== STEP 3: SUBMIT SIGNED TRANSACTION TO HORIZON =====")
              console.log("[Pi A2U] Submitting XDR to Horizon server (Stellar testnet)...")
              
              // Use shared sign/submit/checkpoint function
              // customerAmount = verified U2A amount (payment.amount)
              // actualTransferredAmount = actual A2U operation amount (a2uPayment.amount)
              const checkpointResult = await horizonSignAndCheckpoint(
                horizonServer,
                transaction,
                a2uPayment,
                paymentId,
                payment,
                redis,
                baseFee,
                usedFee,
                amount, // customerAmount: verified U2A amount
                Number(a2uPayment.amount) // actualTransferredAmount: actual A2U amount
              )

              if (!checkpointResult.success) {
                console.error("[Pi A2U] ❌ Checkpoint function failed:", checkpointResult.error)
                
                // If Horizon succeeded but checkpoint failed, return manual-review with txid
                if (checkpointResult.txidFromHorizon) {
                  console.error("[Pi A2U] Horizon succeeded with txid:", checkpointResult.txidFromHorizon)
                  console.error("[Pi A2U] But checkpoint persistence failed")
                  console.error("[Pi A2U] DO NOT call Pi /complete - must return manual-review")
                  
                  return NextResponse.json({
                    success: false,
                    error: checkpointResult.error,
                    txidFromHorizon: checkpointResult.txidFromHorizon,
                    horizonFeeCharged: checkpointResult.horizonFeeCharged,
                    requiresManualReview: true,
                    step: "horizon_success_checkpoint_failed",
                  }, { status: 500 })
                }
                
                // Horizon failed
                throw new Error(checkpointResult.error)
              }

              const txidFromHorizon = checkpointResult.txidFromHorizon!
              const horizonFeeCharged = checkpointResult.horizonFeeCharged!
              } catch (horizonError) {
                const errorMsg = horizonError instanceof Error ? horizonError.message : String(horizonError)
                console.error("[Pi A2U] ❌ STEP 3 FAILED: Horizon submission error")
                console.error("[Pi A2U] Error message:", errorMsg)
                console.error("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
                console.error("[Pi A2U] Fee used for transaction:", usedFee, "stroops")
                
                // Log detailed error response from Horizon
                if (horizonError && typeof horizonError === "object") {
                  const err = horizonError as any
                  
                  // Log response data if available
                  if (err.response && err.response.data) {
                    console.error("[Pi A2U] Horizon response.data:", JSON.stringify(err.response.data, null, 2))
                  }
                  
                  // Log status code
                  if (err.response && err.response.status) {
                    console.error("[Pi A2U] HTTP Status Code:", err.response.status)
                  }
                  
                  // Log extras (result_codes, result_xdr) - THIS IS CRITICAL FOR DEBUGGING
                  if (err.response && err.response.data && err.response.data.extras) {
                    console.error("[Pi A2U] Horizon extras:", JSON.stringify(err.response.data.extras, null, 2))
                    
                    if (err.response.data.extras.result_codes) {
                      console.error("[Pi A2U] Result codes:", err.response.data.extras.result_codes)
                    }
                    
                    if (err.response.data.extras.result_xdr) {
                      console.error("[Pi A2U] Result XDR:", err.response.data.extras.result_xdr)
                    }
                  }
                  
                  // Log raw error object
                  console.error("[Pi A2U] Full error object:", JSON.stringify(err, null, 2))
                }
                
                return NextResponse.json({
                  error: "Failed to submit signed transaction to Horizon/Stellar network",
                  step: "horizonSubmit",
                  piPaymentId: a2uPayment.identifier,
                  details: errorMsg,
                  baseFee,
                  usedFee,
                  success: false,
                }, { status: 500 })
              }
              
              // Now that we have the TXID from Horizon and recovery state is persisted, proceed to Pi /complete
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== STEP 4: SUBMIT TXID TO PI /COMPLETE =====")
              console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments/" + a2uPayment.identifier + "/complete")
              console.log("[Pi A2U] Sending TXID to Pi /complete endpoint...")
              
              const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}/complete`, {
                method: "POST",
                headers: {
                  Authorization: `Key ${config.piApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  txid: txidFromHorizon,
                }),
              })
              
              console.log("[Pi A2U] Pi /complete response status:", completeResponse.status, completeResponse.statusText)
              
              let completeData: any
              
              if (!completeResponse.ok) {
                const completeError = await completeResponse.text()
                console.error("[Pi A2U] ❌ STEP 4 FAILED: Pi /complete returned error")
                console.error("[Pi A2U] HTTP Status:", completeResponse.status)
                console.error("[Pi A2U] Error Response:", completeError)
                
                // Check if it's already_completed - if so, refetch and validate, then return success
                if (completeResponse.status === 400 && completeError.includes("already_completed")) {
                  console.log("[Pi A2U] Payment already_completed on Pi - refetching canonical payment to validate...")
                  
                  const refetchResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}`, {
                    method: "GET",
                    headers: {
                      Authorization: `Key ${config.piApiKey}`,
                      "Content-Type": "application/json",
                    },
                  })
                  
                  if (!refetchResponse.ok) {
                    console.error("[Pi A2U] ❌ Failed to refetch after already_completed")
                    return NextResponse.json({
                      error: "Could not verify already_completed payment",
                      step: "refetch_already_completed",
                      success: false,
                    }, { status: 500 })
                  }
                  
                  completeData = await refetchResponse.json()
                } else {
                  // This is a partial failure - Stellar transaction succeeded but Pi acknowledgement failed
                  console.warn("[Pi A2U] ⚠️  PARTIAL SUCCESS: Transaction on Stellar succeeded (TXID: " + txidFromHorizon + ")")
                  console.warn("[Pi A2U] But Pi API /complete failed - merchant balance may not update")
                  
                  return NextResponse.json({
                    error: "Failed to complete A2U payment on Pi backend",
                    step: "piComplete",
                    piPaymentId: a2uPayment.identifier,
                    txid: txidFromHorizon,
                    details: completeError,
                    piStatus: completeResponse.status,
                    partialSuccess: true,
                    success: false,
                  }, { status: completeResponse.status })
                }
              } else {
                // 2xx response - assign completeData from response
                completeData = await completeResponse.json()
              }
              
              console.log("[Pi A2U] ✓ STEP 4: Pi /complete - SUCCESS")
              console.log("[Pi A2U] Complete response:", JSON.stringify(completeData, null, 2))
              
              // SECURITY: Use strict validator on /complete response
              console.log("[Pi A2U] Validating /complete response with strict validator...")
              const validationResult = validateA2UPayment(
                completeData,
                paymentId,
                amount,
                merchantUid,
                a2uPayment.identifier,
                txidFromHorizon,
                a2uPayment.from_address,
                a2uPayment.to_address
              )
              if (!validationResult.valid) {
                console.error("[Pi A2U] ❌ SECURITY: Response validation failed:", validationResult.error)
                return NextResponse.json({
                  error: "Payment validation failed - " + validationResult.error,
                  step: "complete_validation",
                  success: false,
                }, { status: 400 })
              }
              console.log("[Pi A2U] ✓ All response validations passed")
              
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== ✅ A2U TRANSFER COMPLETE =====")
              console.log("[Pi A2U] All steps completed successfully for ONGOING payment:")
              console.log("[Pi A2U]   1. reused existing ongoing payment")
              console.log("[Pi A2U]   2. build and sign transaction: success")
              console.log("[Pi A2U]   3. submit to Horizon: success (txid:", txidFromHorizon + ")")
              console.log("[Pi A2U]   4. complete on Pi backend: success")
              console.log("[Pi A2U] Merchant wallet has received funds")
              
              // SECURITY: Verify merchant identity from Pi using the access token
              console.log("[Pi A2U] Verifying merchant identity from Pi API...")
              const verifiedIdentity = await verifyMerchantIdentityFromPi(accessToken)
              if (!verifiedIdentity || verifiedIdentity.uid !== merchantUid) {
                console.error("[Pi A2U] ❌ SECURITY: Merchant identity verification failed or uid mismatch")
                return NextResponse.json({
                  error: "Merchant identity verification failed",
                  step: "identity_verification",
                  success: false,
                }, { status: 403 })
              }
              
              // A2U transaction recording is ONLY done in /api/pi/complete after both U2A and A2U confirm
              console.log("[Pi A2U] ✓ A2U transfer completed - accounting will be recorded in /api/pi/complete")
              
              // Build exact success response - include merchant accounting amounts
              // Use actual amounts from checkpoint
              const merchantAmount = Number(a2uPayment.amount) // Actual A2U destination amount
              const appNetImpact = amount - merchantAmount - horizonFeeCharged
              const ongoingSuccessResponse = {
                success: true,
                message: "A2U transfer completed successfully - merchant received funds",
                status: "settled_to_merchant",
                a2uPaymentId: a2uPayment.identifier,
                steps: {
                  reuseExisting: "success",
                  sign: "success",
                  horizonSubmit: "success",
                  piComplete: "success",
                },
                txid: txidFromHorizon,
                customerAmount: amount,  // Verified U2A amount
                merchantAmount: merchantAmount,  // Actual A2U destination amount
                horizonFeeCharged: horizonFeeCharged,  // Actual Horizon fee in Pi
                appCommission: 0,  // Explicit commission (default 0)
                appNetImpact: appNetImpact,  // App's net impact from this transaction
                merchantUid: merchantUid.substring(0, 10) + "...",
                timestamp: new Date().toISOString(),
              }
              
              // MANDATORY: Store A2U completion with both completion fields, full payment/transaction data, and exact success response
              if (isRedisConfigured) {
                const a2uKey = `a2u:${paymentId}`
                const a2uRecord = {
                  ...ongoingSuccessResponse,
                  a2uStatus: "settled_to_merchant",
                  status: "settled_to_merchant",
                  originalPaymentId: paymentId,
                  piPaymentId: a2uPayment.identifier,
                  merchantId,
                  merchantUid,
                  amount,
                  step1: "reused_ongoing",
                  step2: "transaction_signed_success",
                  step3: "horizon_submit_success",
                  step4: "pi_complete_success",
                  txid: txidFromHorizon,
                  completedAt: new Date().toISOString(),
                  payment,
                }
                try {
                  await redis.set(a2uKey, JSON.stringify(a2uRecord))
                  console.log("[Pi A2U] ✓ A2U payment marked as COMPLETE in Redis with full response")
                } catch (error) {
                  console.error("[Pi A2U] ❌ CRITICAL: Failed to write a2u:complete to Redis")
                  console.error("[Pi A2U] Error:", error)
                  throw error
                }
              }
              
              return NextResponse.json(ongoingSuccessResponse)
              
            } catch (signingError) {
              console.error("[Pi A2U] ❌ BLOCKCHAIN SIGNING/SUBMISSION FAILED")
              console.error("[Pi A2U] Error:", signingError instanceof Error ? signingError.message : String(signingError))
              console.error("[Pi A2U] Stack:", signingError instanceof Error ? signingError.stack : "no stack")
              
              return NextResponse.json({
                error: "Blockchain signing or submission failed",
                step: "blockchain_operation",
                details: signingError instanceof Error ? signingError.message : String(signingError),
                success: false,
              }, { status: 500 })
            }
            // === END SIGNING IMPLEMENTATION ==
            
          } catch (error) {
            console.error("[Pi A2U] ❌ Error handling ongoing payment")
            console.error("[Pi A2U] Error:", error instanceof Error ? error.message : String(error))
            
            return NextResponse.json({
              error: "Failed to process ongoing payment",
              details: error instanceof Error ? error.message : String(error),
              success: false,
            }, { status: 500 })
          }
          
          // If we reach here with private seed available, continue to signing code
          // Do NOT return - let code fall through to signing implementation
        } else {
          // Could not extract identifier - log full response for diagnosis
          console.error("[Pi A2U] ❌ FAILED TO EXTRACT ONGOING PAYMENT IDENTIFIER")
          console.error("[Pi A2U] Error response structure did not contain payment.identifier")
          console.error("[Pi A2U] Full error response for diagnosis:", JSON.stringify(errorData, null, 2))
          console.error("[Pi A2U] Response keys:", Object.keys(errorData))
          
          return NextResponse.json(
            {
              error: "Ongoing payment found but identifier could not be extracted",
              details: errorData,
              piStatus: a2uResponse.status,
              success: false,
              diagnosis: "Check error response structure for payment.identifier location",
            },
            { status: a2uResponse.status }
          )
        }
      }
      
      // Not an ongoing_payment_found error - return actual error
      console.error("[Pi A2U] ===== DIAGNOSIS =====")
      console.error("[Pi A2U] The merchantUid that was sent:", merchantUid)
      console.error("[Pi A2U] Error code:", errorData.code || "not provided")
      
      return NextResponse.json(
        {
          error: "Failed to initiate fund transfer to merchant",
          details: errorData,
          piStatus: a2uResponse.status,
          success: false,
          sentUid: merchantUid,
        },
        { status: a2uResponse.status }
      )
    }

    a2uPayment = await a2uResponse.json()
    console.log("[Pi A2U] ✓ STEP 1: createPayment - SUCCESS")
    console.log("[Pi A2U] ===== FULL CREATE PAYMENT RESPONSE =====")
    console.log(JSON.stringify(a2uPayment, null, 2))
    console.log("[Pi A2U] ===== END CREATE RESPONSE =====")
    console.log("[Pi A2U] Pi payment identifier:", a2uPayment.identifier)
    console.log("[Pi A2U] Pi payment status:", a2uPayment.status)
    console.log("[Pi A2U] Pi network:", a2uPayment.network || "not specified")
    console.log("[Pi A2U] From address (app wallet):", a2uPayment.from_address)
    console.log("[Pi A2U] To address (merchant wallet):", a2uPayment.to_address)
    console.log("[Pi A2U] Amount:", a2uPayment.amount)
    console.log("[Pi A2U] Transaction at this stage:", a2uPayment.transaction || "null (will be populated after submit)")
    
    // Ensure we have required payment data
    if (!a2uPayment.identifier) {
      console.error("[Pi A2U] ❌ STEP 1 INCOMPLETE: No identifier returned from createPayment")
      console.error("[Pi A2U] Cannot proceed without payment identifier")
      return NextResponse.json(
        {
          error: "createPayment succeeded but no identifier was returned",
          step: "createPayment",
          details: JSON.stringify(a2uPayment),
          success: false,
        },
        { status: 500 }
      )
    }

    if (!a2uPayment.from_address || !a2uPayment.to_address) {
      console.error("[Pi A2U] ❌ STEP 1 INCOMPLETE: Missing wallet addresses")
      console.error("[Pi A2U] from_address:", a2uPayment.from_address)
      console.error("[Pi A2U] to_address:", a2uPayment.to_address)
      return NextResponse.json(
        {
          error: "createPayment missing wallet addresses",
          step: "createPayment",
          details: JSON.stringify(a2uPayment),
          success: false,
        },
        { status: 500 }
      )
    }
    
    // CRITICAL STEP 2: Build and submit the blockchain transaction
    // The app must sign the transaction using its private seed and submit it to the Stellar network
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== STEP 2: BUILDING & SUBMITTING BLOCKCHAIN TRANSACTION =====")
    console.log("[Pi A2U] From address (app wallet):", a2uPayment.from_address)
    console.log("[Pi A2U] To address (merchant wallet):", a2uPayment.to_address)
    console.log("[Pi A2U] Amount to transfer:", a2uPayment.amount, "Pi")
    console.log("[Pi A2U] Network:", a2uPayment.network)
    console.log("[Pi A2U]")
    
    // Check if app wallet private seed is configured for signing
    const piPrivateSeed = process.env.PI_PRIVATE_SEED
    
    console.log("[Pi A2U] ===== PRIVATE SEED CHECK =====")
    console.log("[Pi A2U] PI_PRIVATE_SEED loaded:", piPrivateSeed ? "YES" : "NO")
    if (piPrivateSeed) {
      console.log("[Pi A2U] PI_PRIVATE_SEED length:", piPrivateSeed.length, "characters")
    }
    console.log("[Pi A2U]")
    
    if (!piPrivateSeed) {
      console.warn("[Pi A2U] ⚠️  PI_PRIVATE_SEED not configured")
      console.warn("[Pi A2U] A2U payment created successfully but blockchain signing requires private seed")
      console.warn("[Pi A2U] Marking A2U settlement as PENDING_SIGNING - requires manual completion or secure seed configuration")
      console.warn("[Pi A2U]")
      console.warn("[Pi A2U] A2U Status: PENDING_SIGNING")
      console.warn("[Pi A2U] Pi Payment ID:", a2uPayment.identifier)
      console.warn("[Pi A2U] From:", a2uPayment.from_address)
      console.warn("[Pi A2U] To:", a2uPayment.to_address)
      console.warn("[Pi A2U] Amount:", a2uPayment.amount, "Pi")
      
      // Store A2U payment in pending state for manual review/signing
      if (isRedisConfigured) {
        try {
          const a2uKey = `a2u:${paymentId}`
          await redis.set(
            a2uKey,
            JSON.stringify({
              originalPaymentId: paymentId,
              piPaymentId: a2uPayment.identifier,
              merchantId,
              merchantUid,
              amount,
              status: "pending_signing",
              fromAddress: a2uPayment.from_address,
              toAddress: a2uPayment.to_address,
              network: a2uPayment.network,
              step1: "createPayment_success",
              step2: "signing_not_configured",
              step3: "pending",
              createdAt: new Date().toISOString(),
              requiresManualReview: true,
              note: "Awaiting PI_PRIVATE_SEED configuration for blockchain signing",
            })
          )
          console.log("[Pi A2U] A2U payment stored with PENDING_SIGNING status in Redis")
        } catch (error) {
          console.warn("[Pi A2U] Failed to store A2U reference (non-blocking):", error)
        }
      }
      
      // Return 202 Accepted - createPayment succeeded, awaiting blockchain signing
      return NextResponse.json({
        success: false, // A2U not complete
        message: "A2U createPayment successful - awaiting blockchain signing",
        status: "pending_signing",
        a2uPaymentId: a2uPayment.identifier,
        step1: "createPayment_success",
        step2: "signing_not_configured",
        step3: "pending",
        fromAddress: a2uPayment.from_address,
        toAddress: a2uPayment.to_address,
        amount,
        network: a2uPayment.network,
        details: "PI_PRIVATE_SEED environment variable required for blockchain signing",
        requiresManualReview: true,
        timestamp: new Date().toISOString(),
      }, { status: 202 }) // 202 Accepted - processing but not complete
    }
    
    console.log("[Pi A2U] ✅ PI_PRIVATE_SEED is configured and available")
    console.log("[Pi A2U] ===== STEP 2: BLOCKCHAIN TRANSACTION SIGNING =====")
    console.log("[Pi A2U] Starting blockchain signing process...")
    console.log("[Pi A2U] Private seed length:", piPrivateSeed.length)
    console.log("[Pi A2U]")
    
    // STEP 2: Build and sign the blockchain transaction
    // This requires Stellar SDK to build a transaction and sign it with the app's private key
    console.log("[Pi A2U] STEP 2 - Build and sign Stellar transaction")
    console.log("[Pi A2U]   From:", a2uPayment.from_address)
    console.log("[Pi A2U]   To:", a2uPayment.to_address)
    console.log("[Pi A2U]   Amount:", a2uPayment.amount, "Pi")
    console.log("[Pi A2U]   Memo:", a2uPayment.identifier)
    console.log("[Pi A2U]")
    
    try {
      // Pi Network uses Stellar's testnet for testing
      // Network passphrase for Pi Testnet (based on Pi's Stellar integration)
      const networkPassphrase = "Pi Testnet"
      
      console.log("[Pi A2U] Creating Stellar keypair from PI_PRIVATE_SEED")
      const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
      const appPublicKey = appKeypair.publicKey()
      
      console.log("[Pi A2U] App wallet address from seed:", appPublicKey)
      console.log("[Pi A2U] Verifying address matches from_address:")
      console.log("[Pi A2U]   from_address:", a2uPayment.from_address)
      console.log("[Pi A2U]   derived address:", appPublicKey)
      
      if (appPublicKey !== a2uPayment.from_address) {
        console.error("[Pi A2U] ❌ ADDRESS MISMATCH")
        console.error("[Pi A2U] The PI_PRIVATE_SEED does not match the app wallet address from Pi")
        console.error("[Pi A2U] Private seed derives to:", appPublicKey)
        console.error("[Pi A2U] Expected app address:", a2uPayment.from_address)
        
        return NextResponse.json({
          error: "Private seed does not match app wallet address",
          step: "key_derivation",
          derivedAddress: appPublicKey,
          expectedAddress: a2uPayment.from_address,
          success: false,
        }, { status: 400 })
      }
      
      console.log("[Pi A2U] ✓ Address verification passed")
      
      // Get server instance for Pi Testnet
      console.log("[Pi A2U] Connecting to Pi Testnet Horizon server")
      const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
        allowHttp: false,
      })
      
      console.log("[Pi A2U] Fetching account information from Horizon")
      const sourceAccount = await horizonServer.loadAccount(appPublicKey)
      console.log("[Pi A2U] ✓ Account loaded")
      console.log("[Pi A2U] Account sequence:", sourceAccount.sequenceNumber())
      
      // CRITICAL: Fetch dynamic base fee from Horizon (not fixed BASE_FEE)
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== FETCHING DYNAMIC FEE FROM HORIZON =====")
      let baseFee: string
      let usedFee: string
      try {
        const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
        baseFee = String(baseFeeFromHorizon)
        // Use 2x base fee to ensure transaction is accepted
        usedFee = (Number(baseFeeFromHorizon) * 2).toString()
        console.log("[Pi A2U] ✓ Dynamic fee fetched from Horizon")
        console.log("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
        console.log("[Pi A2U] Using fee (2x base):", usedFee, "stroops")
      } catch (feeError) {
        console.error("[Pi A2U] ❌ Failed to fetch dynamic fee from Horizon")
        console.error("[Pi A2U] Error:", feeError instanceof Error ? feeError.message : String(feeError))
        console.error("[Pi A2U] Falling back to BASE_FEE constant")
        baseFee = String(StellarSDK.BASE_FEE)
        usedFee = (Number(StellarSDK.BASE_FEE) * 2).toString()
        console.log("[Pi A2U] Fallback base fee:", baseFee, "stroops")
        console.log("[Pi A2U] Fallback used fee:", usedFee, "stroops")
      }
      console.log("[Pi A2U]")
      
      // Build the transaction
      console.log("[Pi A2U] Building Stellar transaction")
      const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
        fee: usedFee,
        networkPassphrase: networkPassphrase,
      })
      
      // Add payment operation
      builder.addOperation(
        StellarSDK.Operation.payment({
          destination: a2uPayment.to_address,
          asset: StellarSDK.Asset.native(), // Pi uses native asset
          amount: a2uPayment.amount.toString(),
        })
      )
      
      // Add memo using the Pi payment identifier
      builder.addMemo(StellarSDK.Memo.text(a2uPayment.identifier.substring(0, 28)))
      
      // Set timeout
      builder.setTimeout(StellarSDK.TimeoutInfinite)
      
      const transaction = builder.build()
      console.log("[Pi A2U] ✓ Transaction built")
      console.log("[Pi A2U] Transaction hash:", transaction.hash().toString("hex"))
      
      // Sign the transaction
      console.log("[Pi A2U] Signing transaction with app private key")
      transaction.sign(appKeypair)
      console.log("[Pi A2U] ✓ Transaction signed")
      
      // Get XDR envelope
      const txEnvelope = transaction.toEnvelope().toXDR()
      const txXDR = txEnvelope.toString("base64")
      console.log("[Pi A2U] Transaction XDR generated")
      console.log("[Pi A2U] XDR length:", txXDR.length, "characters")
      
      // CRITICAL STEP 3: Submit signed XDR to Horizon/Stellar SDK to get TXID
      // This MUST be done via Horizon, not directly to Pi API
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== STEP 3: SUBMIT SIGNED TRANSACTION TO HORIZON =====")
      console.log("[Pi A2U] Submitting XDR to Horizon server (Stellar testnet)...")
      
      // Use shared sign/submit/checkpoint function
      // customerAmount = verified U2A amount (payment.amount)
      // actualTransferredAmount = actual A2U operation amount (a2uPayment.amount)
      const checkpointResult = await horizonSignAndCheckpoint(
        horizonServer,
        transaction,
        a2uPayment,
        paymentId,
        payment,
        redis,
        baseFee,
        usedFee,
        amount, // customerAmount: verified U2A amount
        Number(a2uPayment.amount) // actualTransferredAmount: actual A2U amount
      )

      if (!checkpointResult.success) {
        console.error("[Pi A2U] ❌ Checkpoint function failed:", checkpointResult.error)
        
        // If Horizon succeeded but checkpoint failed, return manual-review with txid
        if (checkpointResult.txidFromHorizon) {
          console.error("[Pi A2U] Horizon succeeded with txid:", checkpointResult.txidFromHorizon)
          console.error("[Pi A2U] But checkpoint persistence failed")
          console.error("[Pi A2U] DO NOT call Pi /complete - must return manual-review")
          
          return NextResponse.json({
            success: false,
            error: checkpointResult.error,
            txidFromHorizon: checkpointResult.txidFromHorizon,
            horizonFeeCharged: checkpointResult.horizonFeeCharged,
            requiresManualReview: true,
            step: "horizon_success_checkpoint_failed",
          }, { status: 500 })
        }
        
        // Horizon failed
        return NextResponse.json({
          error: "Failed to submit signed transaction to Horizon",
          step: "horizonSubmit",
          piPaymentId: a2uPayment.identifier,
          details: checkpointResult.error,
          baseFee,
          usedFee,
          success: false,
        }, { status: 500 })
      }

      const txidFromHorizon = checkpointResult.txidFromHorizon!
      const horizonFeeCharged = checkpointResult.horizonFeeCharged!
      
      // Now that we have the TXID from Horizon, we can proceed to complete the A2U payment
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== STEP 4: SUBMIT TXID TO PI /COMPLETE =====")
      console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments/" + a2uPayment.identifier + "/complete")
      console.log("[Pi A2U] Sending TXID to Pi /complete endpoint...")
      
      const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          txid: txidFromHorizon,
        }),
      })
      
      console.log("[Pi A2U] Pi /complete response status:", completeResponse.status, completeResponse.statusText)
      
      let completeData: any
      
      if (!completeResponse.ok) {
        const completeError = await completeResponse.text()
        console.error("[Pi A2U] ❌ STEP 4 FAILED: Pi /complete returned error")
        console.error("[Pi A2U] HTTP Status:", completeResponse.status)
        console.error("[Pi A2U] Error Response:", completeError)
        
        // Check if it's already_completed - if so, refetch and assign to completeData
        if (completeResponse.status === 400 && completeError.includes("already_completed")) {
          console.log("[Pi A2U] Payment already_completed on Pi - refetching canonical payment to validate...")
          
          const refetchResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}`, {
            method: "GET",
            headers: {
              Authorization: `Key ${config.piApiKey}`,
              "Content-Type": "application/json",
            },
          })
          
          if (!refetchResponse.ok) {
            console.error("[Pi A2U] ❌ Failed to refetch after already_completed")
            return NextResponse.json({
              error: "Could not verify already_completed payment",
              step: "refetch_already_completed",
              success: false,
            }, { status: 500 })
          }
          
          completeData = await refetchResponse.json()
        } else {
          // Any other error is a failure
          console.warn("[Pi A2U] ⚠️  PARTIAL SUCCESS: Transaction on Stellar succeeded (TXID: " + txidFromHorizon + ")")
          console.warn("[Pi A2U] But Pi API /complete failed - merchant balance may not update")
          
          return NextResponse.json({
            error: "Failed to complete A2U payment on Pi backend",
            step: "piComplete",
            piPaymentId: a2uPayment.identifier,
            txid: txidFromHorizon,
            details: completeError,
            piStatus: completeResponse.status,
            partialSuccess: true,
            success: false,
          }, { status: completeResponse.status })
        }
      } else {
        // 2xx response - assign completeData from response
        completeData = await completeResponse.json()
      }
      
      console.log("[Pi A2U] ✓ STEP 4: Pi /complete - SUCCESS")
      console.log("[Pi A2U] Complete response:", JSON.stringify(completeData, null, 2))
      
      // SECURITY: Use strict validator on /complete response
      console.log("[Pi A2U] Validating /complete response with strict validator...")
      const validationResult = validateA2UPayment(
        completeData,
        paymentId,
        amount,
        merchantUid,
        a2uPayment.identifier,
        txidFromHorizon,
        a2uPayment.from_address,
        a2uPayment.to_address
      )
      if (!validationResult.valid) {
        console.error("[Pi A2U] ❌ SECURITY: Response validation failed:", validationResult.error)
        return NextResponse.json({
          error: "Payment validation failed - " + validationResult.error,
          step: "complete_validation",
          success: false,
        }, { status: 400 })
      }

      
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== ✅ A2U TRANSFER COMPLETE =====")
      console.log("[Pi A2U] All four steps completed successfully:")
      console.log("[Pi A2U]   1. createPayment: success")
      console.log("[Pi A2U]   2. build and sign transaction: success")
      console.log("[Pi A2U]   3. submit to Horizon: success (txid:", txidFromHorizon + ")")
      console.log("[Pi A2U]   4. complete on Pi backend: success")
      console.log("[Pi A2U] Merchant wallet has received funds")
      
      // MANDATORY: Store A2U completion in Redis with BOTH a2uStatus and status fields BEFORE returning success
      if (isRedisConfigured) {
        const a2uCompleteKey = `a2u:${paymentId}`
        const a2uCompleteData = {
          ...payment, // Include full payment record
          ...{
            originalPaymentId: paymentId,
            piPaymentId: a2uPayment.identifier,
            merchantId,
            merchantUid,
            amount,
            a2uStatus: "settled_to_merchant", // Both fields required
            status: "settled_to_merchant",
            step1: "createPayment_success",
            step2: "transaction_signed_success",
            step3: "horizon_submit_success",
            step4: "pi_complete_success",
            txid: txidFromHorizon,
            completedAt: new Date().toISOString(),
          }
        }
        try {
          await redis.set(a2uCompleteKey, JSON.stringify(a2uCompleteData))
          console.log("[Pi A2U] ✓ A2U marked complete in Redis with both a2uStatus and status fields")
        } catch (error) {
          console.error("[Pi A2U] ❌ CRITICAL: Failed to write a2u:complete to Redis")
          console.error("[Pi A2U] Error:", error)
          throw error // Fail the transaction if we can't persist
        }
      }
      
      // Lock will be released in finally block
      
      return NextResponse.json({
        success: true,
        message: "A2U transfer completed successfully - merchant received funds",
        status: "settled_to_merchant",
        a2uPaymentId: a2uPayment.identifier,
        steps: {
          createPayment: "success",
          sign: "success",
          horizonSubmit: "success",
          piComplete: "success",
        },
        txid: txidFromHorizon,
        amount,
        merchantUid: merchantUid.substring(0, 10) + "...",
        timestamp: new Date().toISOString(),
      })
      
    } catch (signingError) {
      console.error("[Pi A2U] ❌ BLOCKCHAIN SIGNING/SUBMISSION FAILED")
      console.error("[Pi A2U] Error:", signingError instanceof Error ? signingError.message : String(signingError))
      console.error("[Pi A2U] Stack:", signingError instanceof Error ? signingError.stack : "no stack")
      
      return NextResponse.json({
        error: "Blockchain signing or submission failed",
        step: "blockchain_operation",
        details: signingError instanceof Error ? signingError.message : String(signingError),
        success: false,
      }, { status: 500 })
    }
    } finally {
      // CONCURRENCY: Release lock atomically using Lua compare-and-delete
      // This is the ONLY place releaseLockAtomic is called
      if (lockAcquired && lockToken) {
        console.log("[Pi A2U] ===== RELEASING CONCURRENCY LOCK =====")
        await releaseLockAtomic()
      }
    }
  } catch (error) {
    console.error("[Pi A2U] ❌ UNEXPECTED ERROR")
    console.error("[Pi A2U] Error type:", error instanceof Error ? error.constructor.name : typeof error)
    console.error("[Pi A2U] Error message:", error instanceof Error ? error.message : String(error))
    console.error("[Pi A2U] Full error:", error)
    return NextResponse.json(
      {
        error: "Failed to process fund transfer",
        details: error instanceof Error ? error.message : String(error),
        success: false,
      },
      { status: 500 }
    )
  }
}
