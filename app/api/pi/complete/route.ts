import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordA2UTransactionAtomic } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/pi/complete
 * 
 * Client-facing endpoint that completes U2A payment verification from Pi.
 * Receives Pi payment identifier and txid from Pi Wallet callback.
 * 
 * SECURITY:
 * - Accepts ONLY piPaymentId + txid from client (verified by Pi Wallet signature)
 * - All trusted payment data (amount, merchant, addresses) from Redis
 * - Uses A2U_INTERNAL_SECRET (from environment, fail-closed) for server-to-server calls
 * 
 * Flow:
 * 1. Verify Pi payment from Redis canonical store
 * 2. If already settled_to_merchant: return 200 (idempotent)
 * 3. Set status to paid_to_app (U2A complete)
 * 4. Call /api/pi/a2u endpoint with A2U_INTERNAL_SECRET to begin settlement
 * 5. Track settlement states: settlement_pending, settled_to_merchant, or settlement_failed
 * 
 * Never downgrades settled_to_merchant back to earlier states.
 */
export async function POST(request: NextRequest) {
  console.log("[Pi Complete] Request received at", new Date().toISOString())

  try {
    // Fail closed: require A2U_INTERNAL_SECRET from environment
    if (!config.a2uInternalSecret || typeof config.a2uInternalSecret !== "string") {
      console.error("[Pi Complete] SECURITY: A2U_INTERNAL_SECRET not configured - REJECTING ALL REQUESTS")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    // 1. Parse request - accept ONLY piPaymentId (Pi identifier) + txid (Pi transaction)
    const body = await request.json()
    const { piPaymentId, txid } = body
    
    if (!piPaymentId || !txid) {
      console.error("[Pi Complete] Missing piPaymentId or txid")
      return NextResponse.json({ error: "Missing piPaymentId or txid" }, { status: 400 })
    }

    console.log("[Pi Complete] Processing Pi payment:", piPaymentId, "txid:", txid)

    // 2. Fetch canonical payment state directly from Pi API (not Redis)
    // Redis pi_payment:* keys are never created - fetch from authoritative Pi API source
    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Complete] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    console.log("[Pi Complete] Fetching canonical payment from Pi API for piPaymentId:", piPaymentId)
    
    const piApiResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
      method: "GET",
      headers: {
        "Authorization": `Key ${config.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!piApiResponse.ok) {
      console.error("[Pi Complete] Failed to fetch Pi payment - status:", piApiResponse.status)
      const errorBody = await piApiResponse.text()
      console.error("[Pi Complete] Pi API error:", errorBody)
      return NextResponse.json({ error: "Pi payment verification failed" }, { status: 400 })
    }

    const canonicalPayment = await piApiResponse.json()
    console.log("[Pi Complete] Canonical Pi payment fetched:", {
      identifier: canonicalPayment.identifier,
      hasMetadata: !!canonicalPayment.metadata,
      hasTxid: !!canonicalPayment.transaction?.txid,
      hasStatus: !!canonicalPayment.status,
    })

    // 3. Comprehensive validation of canonical payment from Pi API
    console.log("[Pi Complete] === VALIDATING CANONICAL PAYMENT FROM PI API ===")
    
    // Validate identifier (Pi identifier, not our internal paymentId)
    if (!canonicalPayment.identifier || typeof canonicalPayment.identifier !== "string") {
      console.error("[Pi Complete] Missing or invalid identifier:", canonicalPayment.identifier)
      return NextResponse.json({ error: "Invalid Pi payment identifier" }, { status: 400 })
    }

    // Validate amount
    if (!canonicalPayment.amount || typeof canonicalPayment.amount !== "number") {
      console.error("[Pi Complete] Invalid amount in canonical payment:", canonicalPayment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    // Validate direction is user_to_app (U2A, not app_to_user)
    if (canonicalPayment.direction !== "user_to_app") {
      console.error("[Pi Complete] Invalid direction:", canonicalPayment.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    // Validate cancellation flags
    if (canonicalPayment.status === "cancelled" || canonicalPayment.is_cancelled === true) {
      console.error("[Pi Complete] Payment was cancelled")
      return NextResponse.json({ error: "Payment was cancelled" }, { status: 400 })
    }

    // Validate transaction exists and has txid
    const canonicalTxid = canonicalPayment.transaction?.txid
    if (!canonicalTxid || typeof canonicalTxid !== "string") {
      console.error("[Pi Complete] Missing or invalid transaction txid in canonical payment")
      return NextResponse.json({ error: "Invalid transaction ID" }, { status: 400 })
    }

    // Validate transaction txid matches what Pi Wallet sent
    if (canonicalTxid !== txid) {
      console.error("[Pi Complete] Transaction txid mismatch - canonical:", canonicalTxid, "wallet:", txid)
      return NextResponse.json({ error: "Transaction verification failed" }, { status: 400 })
    }

    // Validate developer_approved flag if present
    if (canonicalPayment.developer_approved === false) {
      console.error("[Pi Complete] Developer did not approve payment")
      return NextResponse.json({ error: "Payment not approved" }, { status: 400 })
    }

    // Validate transaction_verified flag
    if (canonicalPayment.transaction?.verified !== true) {
      console.error("[Pi Complete] Transaction not verified by Pi")
      return NextResponse.json({ error: "Transaction not verified" }, { status: 400 })
    }

    // Validate developer_completed flag if applicable
    // Some payment states may not require this, but if present it must be true
    if (canonicalPayment.developer_completed === false) {
      console.error("[Pi Complete] Developer did not mark payment as completed")
      return NextResponse.json({ error: "Payment not marked completed by developer" }, { status: 400 })
    }

    // Derive paymentId ONLY from canonical payment metadata (never trust client)
    const paymentId = canonicalPayment.metadata?.paymentId
    if (!paymentId || typeof paymentId !== "string") {
      console.error("[Pi Complete] Invalid canonical payment - missing or invalid paymentId in metadata")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    console.log("[Pi Complete] === CANONICAL PAYMENT VALIDATED - deriving paymentId:", paymentId)

    // Load the actual payment record using the derived paymentId
    const paymentKey = `payment:${paymentId}`
    const paymentData = await redis.get(paymentKey)
    
    if (!paymentData) {
      console.error("[Pi Complete] Payment record not found:", paymentId)
      return NextResponse.json({ error: "Payment record not found" }, { status: 404 })
    }

    const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
    console.log("[Pi Complete] Payment record loaded - ID:", paymentId, "Status:", payment.status)

    // Validate local payment amount matches canonical amount
    if (canonicalPayment.amount !== payment.amount) {
      console.error("[Pi Complete] Amount mismatch - canonical:", canonicalPayment.amount, "local:", payment.amount)
      return NextResponse.json({ error: "Amount verification failed" }, { status: 400 })
    }

    console.log("[Pi Complete] === ALL VALIDATIONS PASSED ===")

    // 4. Handle retry cases and idempotency - NEVER downgrade settled_to_merchant
    console.log("[Pi Complete] Current payment status:", payment.status)
    
    if (payment.status === "settled_to_merchant") {
      console.log("[Pi Complete] Already settled to merchant - returning current state (NO DOWNGRADE)")
      return NextResponse.json({
        status: "settled_to_merchant",
        paymentId,
        txid: payment.a2uTxid || txid,
      })
    }

    if (payment.status === "settlement_failed") {
      console.log("[Pi Complete] Settlement previously failed - requires manual review")
      return NextResponse.json({
        status: "settlement_failed",
        paymentId,
        error: payment.a2uError || "Settlement failed",
        requiresManualReview: true,
      })
    }

    if (payment.status === "settlement_pending" && payment.a2uPaymentId) {
      // Reattempt to complete the SAME A2U transfer
      console.log("[Pi Complete] Retry: reattempting settlement_pending transfer")
      console.log("[Pi Complete] Reusing A2U payment ID:", payment.a2uPaymentId)
      
      // Call A2U complete endpoint to verify/finalize
      const a2uCompleteResponse = await fetch(`${config.appUrl}/api/pi/a2u`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flashpay-internal-secret": config.a2uInternalSecret,
        },
        body: JSON.stringify({
          action: "verify_and_complete",
          a2uPaymentId: payment.a2uPaymentId,
          paymentId,
        }),
      })

      if (a2uCompleteResponse.ok) {
        const a2uData = await a2uCompleteResponse.json()
        if (a2uData.success && a2uData.txid) {
          // DB insert succeeded - mark as settled
          await redis.set(
            `payment:${paymentId}`,
            JSON.stringify({
              ...payment,
              status: "settled_to_merchant",
              a2uTxid: a2uData.txid,
              settlementCompletedAt: new Date().toISOString(),
            })
          )
          console.log("[Pi Complete] Retry succeeded - marked settled_to_merchant")
          return NextResponse.json({ status: "settled_to_merchant", paymentId })
        }
      }
      
      return NextResponse.json({ status: "settlement_pending", paymentId })
    }

    // 4. Only allow completion from pending state
    if (payment.status !== "pending") {
      console.error("[Pi Complete] Cannot complete from status:", payment.status)
      return NextResponse.json(
        { error: "Invalid payment status for completion", status: payment.status },
        { status: 400 }
      )
    }

    // 5. Persist verified identifiers from canonical Pi API payment
    // Use txid (Pi Wallet callback), not canonicalTxid, as the single authoritative U2A txid
    console.log("[Pi Complete] Persisting verified identifiers - piPaymentId:", piPaymentId, "u2aTxid:", txid)
    
    const updatedPayment = {
      ...payment,
      status: "paid_to_app",
      piPaymentId,
      u2aTxid: txid,  // Single txid field from Pi Wallet callback (verified against canonical)
      paidAt: new Date().toISOString(),
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
    console.log("[Pi Complete] Payment persisted - status: paid_to_app, txid verified against canonical Pi payment")

    // 6. Call A2U endpoint to begin settlement with validated paymentId
    console.log("[Pi Complete] Initiating A2U settlement for paymentId:", paymentId)
    
    const a2uResponse = await fetch(`${config.appUrl}/api/pi/a2u`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flashpay-internal-secret": config.a2uInternalSecret,
      },
      body: JSON.stringify({ paymentId }),
    })

    const a2uData = await a2uResponse.json()

    // Handle A2U responses
    if (a2uResponse.status === 202) {
      // A2U pending (createPayment succeeded, signing in progress)
      console.log("[Pi Complete] A2U pending - payment created but signing not yet complete")
      
      // Atomically save A2U identifiers before returning
      if (a2uData.a2uPaymentId) {
        const settlementPendingPayment = {
          ...updatedPayment,
          status: "settlement_pending",
          a2uPaymentId: a2uData.a2uPaymentId,
          a2uFromAddress: a2uData.fromAddress,
          a2uToAddress: a2uData.toAddress,
          settlementStartedAt: new Date().toISOString(),
        }
        
        await redis.set(`payment:${paymentId}`, JSON.stringify(settlementPendingPayment))
        console.log("[Pi Complete] Saved A2U identifiers, status: settlement_pending")
      }

      return NextResponse.json({ status: "settlement_pending", paymentId }, { status: 202 })
    }

    if (!a2uResponse.ok || !a2uData.success) {
      console.error("[Pi Complete] A2U failed:", a2uData.error)
      
      // Save A2U error state for manual review - preserve verified identifiers
      const failedPayment = {
        ...updatedPayment,
        status: "settlement_failed",
        a2uError: a2uData.error,
        a2uPaymentId: a2uData.a2uPaymentId,
        settlementAttemptedAt: new Date().toISOString(),
        requiresManualReview: true,
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(failedPayment))

      return NextResponse.json(
        {
          status: "settlement_failed",
          paymentId,
          error: a2uData.error,
          requiresManualReview: true,
        },
        { status: 400 }
      )
    }

    // 9. A2U succeeded - IMMEDIATELY persist identifiers AND financial data to Redis BEFORE DB call
    // This ensures idempotent recovery: if DB fails, we can retry with same A2U transfer
    console.log("[Pi Complete] A2U succeeded, persisting identifiers AND financial data BEFORE DB call")
    console.log("[Pi Complete] Horizon txid:", a2uData.txid)
    console.log("[Pi Complete] Horizon fee charged:", a2uData.feeCharged)
    console.log("[Pi Complete] Customer amount (from A2U):", a2uData.customerAmount)
    console.log("[Pi Complete] Merchant amount (from A2U):", a2uData.merchantAmount)

    // CRITICAL: Save A2U identifiers + authoritative financial data atomically BEFORE calling DB
    // This is the recovery state: if anything fails after this, retry uses stored identifiers and amounts
    const settlementCompletePayment = {
      ...updatedPayment,
      status: "settlement_pending",
      a2uPaymentId: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      a2uFromAddress: a2uData.fromAddress,
      a2uToAddress: a2uData.toAddress,
      customerAmount: a2uData.customerAmount || updatedPayment.amount, // From A2U, fallback to payment amount
      merchantAmount: a2uData.merchantAmount || a2uData.customerAmount || updatedPayment.amount, // Actual A2U transfer
      horizonFeeCharged: a2uData.horizonFeeCharged || a2uData.feeCharged || 0, // Actual Horizon fee
      appCommission: a2uData.appCommission || 0, // Explicit commission
      appNetImpact: a2uData.appNetImpact || (a2uData.customerAmount - a2uData.merchantAmount - (a2uData.horizonFeeCharged || a2uData.feeCharged || 0)), // App's net
      settlementCompletedAt: new Date().toISOString(),
    }
    
    await redis.set(`payment:${paymentId}`, JSON.stringify(settlementCompletePayment))
    console.log("[Pi Complete] ✓ A2U identifiers persisted to Redis (recovery state)")

    // 10. Now attempt DB transaction - use AUTHORITATIVE values from settlement checkpoint
    // CRITICAL: These values were persisted from A2U response and saved to Redis above
    // NO fallbacks - must have all values or error
    console.log("[Pi Complete] Recording atomic A2U transaction to database")
    console.log("[Pi Complete] AUTHORITATIVE FINANCIAL DATA FROM SETTLEMENT CHECKPOINT:")
    console.log("[Pi Complete]   - customerAmount (verified U2A):", settlementCompletePayment.customerAmount)
    console.log("[Pi Complete]   - merchantAmount (actual A2U):", settlementCompletePayment.merchantAmount)
    console.log("[Pi Complete]   - horizonFeeCharged (actual fee):", settlementCompletePayment.horizonFeeCharged)
    console.log("[Pi Complete]   - appCommission:", settlementCompletePayment.appCommission)
    console.log("[Pi Complete]   - appNetImpact:", settlementCompletePayment.appNetImpact)
    
    // Validate that all financial values exist - no silent fallbacks
    if (!settlementCompletePayment.customerAmount || settlementCompletePayment.customerAmount <= 0) {
      console.error("[Pi Complete] CRITICAL: customerAmount missing or invalid from checkpoint")
      return NextResponse.json({ error: "Missing authoritative customer amount" }, { status: 500 })
    }
    if (!settlementCompletePayment.merchantAmount || settlementCompletePayment.merchantAmount <= 0) {
      console.error("[Pi Complete] CRITICAL: merchantAmount missing or invalid from checkpoint")
      return NextResponse.json({ error: "Missing authoritative merchant amount" }, { status: 500 })
    }
    if (settlementCompletePayment.horizonFeeCharged === undefined || settlementCompletePayment.horizonFeeCharged < 0) {
      console.error("[Pi Complete] CRITICAL: horizonFeeCharged missing or invalid from checkpoint")
      return NextResponse.json({ error: "Missing authoritative horizon fee" }, { status: 500 })
    }
    
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: updatedPayment.piPaymentId,
      u2aTxid: updatedPayment.u2aTxid,
      a2uIdentifier: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      merchantId: canonicalPayment.metadata?.merchantId,
      merchantUid: canonicalPayment.metadata?.merchantUid,
      customerAmount: settlementCompletePayment.customerAmount, // Authoritative from checkpoint
      merchantAmount: settlementCompletePayment.merchantAmount, // Authoritative from checkpoint
      horizonFeeCharged: settlementCompletePayment.horizonFeeCharged, // Authoritative from checkpoint
      appCommission: settlementCompletePayment.appCommission || 0, // Explicit commission
    })

    if (dbResult.success) {
      console.log("[Pi Complete] ✓ Atomic transaction recorded")
      console.log("[Pi Complete] Accounting reconciliation (from settlement checkpoint):")
      const appNetImpact = settlementCompletePayment.customerAmount - settlementCompletePayment.merchantAmount - settlementCompletePayment.horizonFeeCharged
      console.log("[Pi Complete]   - Customer amount:", settlementCompletePayment.customerAmount)
      console.log("[Pi Complete]   - Merchant credited:", settlementCompletePayment.merchantAmount)
      console.log("[Pi Complete]   - Horizon fee:", settlementCompletePayment.horizonFeeCharged)
      console.log("[Pi Complete]   - App absorbs:", appNetImpact)
      console.log("[Pi Complete]   - Merchant balance updated in database")
      
      // CRITICAL: Only mark settled AFTER DB commit succeeds
      const finalPayment = {
        ...settlementCompletePayment,
        status: "settled_to_merchant",
        settledAt: new Date().toISOString(),
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(finalPayment))
      console.log("[Pi Complete] ✓ Payment fully settled to merchant - accounting complete")

      return NextResponse.json({ status: "settled_to_merchant", paymentId })
    } else {
      console.error("[Pi Complete] DB transaction failed:", dbResult.error)
      
      // DB failed but A2U succeeded - recovery state already persisted
      // Mark requiresDbReconciliation so retry knows to complete DB only
      const reconciliationNeededPayment = {
        ...settlementCompletePayment,
        requiresDbReconciliation: true,
        dbError: dbResult.error,
        dbAttemptedAt: new Date().toISOString(),
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(reconciliationNeededPayment))
      console.log("[Pi Complete] ⚠️  DB failed but A2U succeeded - marked requiresDbReconciliation")

      return NextResponse.json(
        {
          status: "settlement_pending",
          paymentId,
          requiresDbReconciliation: true,
          message: "A2U succeeded but DB write failed - will retry on next check",
        },
        { status: 202 }
      )
    }
  } catch (error) {
    console.error("[Pi Complete] Error:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    )
  }
}
