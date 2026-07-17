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

    // 2. Get canonical payment state from Redis using piPaymentId
    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    // Look up canonical Pi payment by piPaymentId to derive paymentId from metadata
    // Fail fast: Do not scan all payment:* keys. Use direct piPaymentId lookup.
    console.log("[Pi Complete] Looking up canonical Pi payment for piPaymentId:", piPaymentId)
    
    const canonicalKey = `pi_payment:${piPaymentId}`
    const canonicalData = await redis.get(canonicalKey)
    
    if (!canonicalData) {
      console.error("[Pi Complete] Canonical Pi payment not found:", piPaymentId)
      return NextResponse.json({ error: "Pi payment not found" }, { status: 404 })
    }

    const canonicalPayment = typeof canonicalData === "string" ? JSON.parse(canonicalData) : canonicalData
    console.log("[Pi Complete] Canonical Pi payment data:", {
      piPaymentId: canonicalPayment.piPaymentId,
      hasMetadata: !!canonicalPayment.metadata,
      hasTxid: !!canonicalPayment.txid,
    })

    // Derive paymentId ONLY from canonical payment metadata
    // Never trust client-provided paymentId
    const paymentId = canonicalPayment.metadata?.paymentId
    if (!paymentId) {
      console.error("[Pi Complete] Invalid canonical payment - missing paymentId in metadata")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    // Load the actual payment record using the derived paymentId
    const paymentKey = `payment:${paymentId}`
    const paymentData = await redis.get(paymentKey)
    
    if (!paymentData) {
      console.error("[Pi Complete] Payment record not found:", paymentId)
      return NextResponse.json({ error: "Payment record not found" }, { status: 404 })
    }

    const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
    console.log("[Pi Complete] Payment record found - ID:", paymentId, "Status:", payment.status)

    // 3. Comprehensive validation of canonical payment data
    console.log("[Pi Complete] === VALIDATING CANONICAL PAYMENT ===")
    
    if (!canonicalPayment.piPaymentId) {
      console.error("[Pi Complete] Missing canonical piPaymentId")
      return NextResponse.json({ error: "Invalid Pi payment identifier" }, { status: 400 })
    }

    if (!canonicalPayment.amount || typeof canonicalPayment.amount !== "number") {
      console.error("[Pi Complete] Invalid amount in canonical payment:", canonicalPayment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    if (canonicalPayment.amount !== payment.amount) {
      console.error("[Pi Complete] Amount mismatch - canonical:", canonicalPayment.amount, "payment:", payment.amount)
      return NextResponse.json({ error: "Amount verification failed" }, { status: 400 })
    }

    if (canonicalPayment.direction !== "u2a") {
      console.error("[Pi Complete] Invalid direction:", canonicalPayment.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    if (canonicalPayment.metadata?.paymentId !== paymentId) {
      console.error("[Pi Complete] Metadata paymentId mismatch")
      return NextResponse.json({ error: "Metadata verification failed" }, { status: 400 })
    }

    if (canonicalPayment.status === "cancelled") {
      console.error("[Pi Complete] Payment was cancelled")
      return NextResponse.json({ error: "Payment was cancelled" }, { status: 400 })
    }

    if (!canonicalPayment.txid || typeof canonicalPayment.txid !== "string") {
      console.error("[Pi Complete] Missing or invalid txid in canonical payment")
      return NextResponse.json({ error: "Invalid transaction ID" }, { status: 400 })
    }

    console.log("[Pi Complete] === CANONICAL PAYMENT VALIDATED ===")

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

    // 5. Verify txid from Pi Wallet matches canonical record
    console.log("[Pi Complete] Verifying txid from Pi Wallet against canonical payment")
    console.log("[Pi Complete] Canonical txid:", canonicalPayment.txid, "Wallet txid:", txid)
    
    if (canonicalPayment.txid !== txid) {
      console.error("[Pi Complete] Transaction ID mismatch - payment record txid:", canonicalPayment.txid, "wallet txid:", txid)
      return NextResponse.json({ error: "Transaction verification failed" }, { status: 400 })
    }

    // 6. Only allow completion from pending state
    if (payment.status !== "pending") {
      console.error("[Pi Complete] Cannot complete from status:", payment.status)
      return NextResponse.json(
        { error: "Invalid payment status for completion", status: payment.status },
        { status: 400 }
      )
    }

    // 7. Persist verified piPaymentId and U2A txid before transitioning
    console.log("[Pi Complete] Persisting verified identifiers - piPaymentId:", piPaymentId, "U2A txid:", txid)
    
    const updatedPayment = {
      ...payment,
      status: "paid_to_app",
      piPaymentId,
      u2aTxid: txid,
      paidAt: new Date().toISOString(),
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
    console.log("[Pi Complete] Payment persisted - status: paid_to_app, txid verified")

    // 8. Call A2U endpoint with ONLY paymentId + internal secret from environment
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

    // 9. A2U succeeded - IMMEDIATELY persist identifiers to Redis BEFORE DB call
    // This ensures idempotent recovery: if DB fails, we can retry with same A2U transfer
    console.log("[Pi Complete] A2U succeeded, persisting identifiers BEFORE DB call")
    console.log("[Pi Complete] Horizon txid:", a2uData.txid)
    console.log("[Pi Complete] Horizon fee charged:", a2uData.feeCharged)

    // CRITICAL: Save A2U identifiers atomically BEFORE calling DB
    // This is the recovery state: if anything fails after this, retry uses stored identifiers
    const settlementCompletePayment = {
      ...updatedPayment,
      status: "settlement_pending",
      a2uPaymentId: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      a2uFromAddress: a2uData.fromAddress,
      a2uToAddress: a2uData.toAddress,
      horizonFeeCharged: a2uData.feeCharged,
      settlementCompletedAt: new Date().toISOString(),
    }
    
    await redis.set(`payment:${paymentId}`, JSON.stringify(settlementCompletePayment))
    console.log("[Pi Complete] ✓ A2U identifiers persisted to Redis (recovery state)")

    // 10. Now attempt DB transaction - use verified identifiers from updatedPayment
    console.log("[Pi Complete] Recording atomic A2U transaction to database")
    console.log("[Pi Complete] Accounting breakdown from A2U response:")
    console.log("[Pi Complete]   - customerAmount:", a2uData.customerAmount || payment.amount)
    console.log("[Pi Complete]   - merchantAmount:", a2uData.merchantAmount || payment.amount)
    console.log("[Pi Complete]   - horizonFeeCharged:", a2uData.feeCharged)
    
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: updatedPayment.piPaymentId,
      u2aTxid: updatedPayment.u2aTxid,
      a2uIdentifier: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      merchantId: canonicalPayment.metadata?.merchantId,
      merchantUid: canonicalPayment.metadata?.merchantUid,
      customerAmount: a2uData.customerAmount || payment.amount,
      merchantAmount: a2uData.merchantAmount || payment.amount,
      horizonFeeCharged: a2uData.feeCharged || 0,
      appCommission: payment.appCommission || 0,
    })

    if (dbResult.success) {
      console.log("[Pi Complete] ✓ Atomic transaction recorded")
      console.log("[Pi Complete] Accounting reconciliation:")
      const appNetImpact = (a2uData.customerAmount || payment.amount) - (a2uData.merchantAmount || payment.amount) - (a2uData.feeCharged || 0)
      console.log("[Pi Complete]   - Merchant credited:", a2uData.merchantAmount || payment.amount)
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
