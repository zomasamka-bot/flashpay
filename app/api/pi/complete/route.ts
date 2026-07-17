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
    if (!config.a2uInternalSecret) {
      console.error("[Pi Complete] SECURITY: A2U_INTERNAL_SECRET not configured - rejecting request")
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

    // 2. Get canonical payment state from Redis
    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    // Look up by piPaymentId first to find the payment record
    // All payments are stored with paymentId as key
    const paymentKeys = await redis.keys("payment:*")
    let paymentId: string | null = null
    let payment: any = null

    for (const key of paymentKeys) {
      const paymentData = await redis.get(key)
      const p = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
      if (p.piPaymentId === piPaymentId) {
        paymentId = key.replace("payment:", "")
        payment = p
        break
      }
    }

    if (!payment || !paymentId) {
      console.error("[Pi Complete] Payment not found for piPaymentId:", piPaymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    console.log("[Pi Complete] Payment found - ID:", paymentId, "Status:", payment.status)

    // 3. Handle retry cases and idempotency - NEVER downgrade settled_to_merchant
    if (payment.status === "settled_to_merchant") {
      console.log("[Pi Complete] Already settled to merchant - returning current state (NO DOWNGRADE)")
      return NextResponse.json({
        status: "settled_to_merchant",
        paymentId,
        txid: payment.a2uTxid,
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
              settledAt: new Date().toISOString(),
            })
          )
          console.log("[Pi Complete] Retry succeeded - marked settled_to_merchant")
          return NextResponse.json({ status: "settled_to_merchant", paymentId })
        }
      }
      
      return NextResponse.json({ status: "settlement_pending", paymentId })
    }

    // 4. Handle payment states
    if (payment.status !== "pending") {
      console.error("[Pi Complete] Unexpected status:", payment.status, "expected pending")
      return NextResponse.json(
        { error: "Invalid payment status for completion", status: payment.status },
        { status: 400 }
      )
    }

    // Verify Pi txid matches canonical record
    if (payment.txid !== txid) {
      console.error("[Pi Complete] txid mismatch - expected:", payment.txid, "got:", txid)
      return NextResponse.json({ error: "Transaction mismatch" }, { status: 400 })
    }

    // 5. Mark as paid_to_app (U2A complete) before calling A2U
    console.log("[Pi Complete] U2A verified, marking paid_to_app and initiating A2U settlement")
    
    await redis.set(
      `payment:${paymentId}`,
      JSON.stringify({
        ...payment,
        status: "paid_to_app",
        paidAt: new Date().toISOString(),
      })
    )
    console.log("[Pi Complete] Payment marked paid_to_app")

    // 6. Call A2U endpoint with ONLY paymentId + internal secret from environment
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
        await redis.set(
          `payment:${paymentId}`,
          JSON.stringify({
            ...payment,
            status: "settlement_pending",
            a2uPaymentId: a2uData.a2uPaymentId,
            a2uFromAddress: a2uData.fromAddress,
            a2uToAddress: a2uData.toAddress,
          })
        )
        console.log("[Pi Complete] Saved A2U identifiers, returning pending")
      }

      return NextResponse.json({ status: "settlement_pending", paymentId }, { status: 202 })
    }

    if (!a2uResponse.ok || !a2uData.success) {
      console.error("[Pi Complete] A2U failed:", a2uData.error)
      
      // Save A2U error state for manual review
      await redis.set(
        `payment:${paymentId}`,
        JSON.stringify({
          ...payment,
          status: "settlement_failed",
          a2uError: a2uData.error,
          a2uPaymentId: a2uData.a2uPaymentId,
          requiresManualReview: true,
        })
      )

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

    // A2U succeeded - IMMEDIATELY persist identifiers to Redis BEFORE DB call
    // This ensures idempotent recovery: if DB fails, we can retry with same A2U transfer
    console.log("[Pi Complete] A2U succeeded, persisting identifiers BEFORE DB call")
    console.log("[Pi Complete] Horizon txid:", a2uData.txid)
    console.log("[Pi Complete] Horizon fee charged:", a2uData.feeCharged)

    // CRITICAL: Save A2U identifiers atomically BEFORE calling DB
    // This is the recovery state: if anything fails after this, retry uses stored identifiers
    await redis.set(
      `payment:${paymentId}`,
      JSON.stringify({
        ...payment,
        status: "settlement_pending",
        a2uPaymentId: a2uData.a2uPaymentId,
        a2uTxid: a2uData.txid,
        a2uFromAddress: a2uData.fromAddress,
        a2uToAddress: a2uData.toAddress,
        horizonFeeCharged: a2uData.feeCharged,
        // No requiresDbReconciliation yet - we haven't tried DB
      })
    )
    console.log("[Pi Complete] ✓ A2U identifiers persisted to Redis (recovery state)")

    // Now attempt DB transaction
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: payment.piPaymentId,
      u2aTxid: payment.txid,
      a2uIdentifier: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      merchantId: payment.merchantId,
      merchantUid: payment.merchantUid,
      amount: payment.amount,
      horizonFeeCharged: a2uData.feeCharged,
      appCommission: payment.appCommission || 0,
    })

    if (dbResult.success) {
      console.log("[Pi Complete] Atomic transaction recorded, marking settled_to_merchant")
      
      // CRITICAL: Only mark settled AFTER DB commit succeeds
      await redis.set(
        `payment:${paymentId}`,
        JSON.stringify({
          ...payment,
          status: "settled_to_merchant",
          a2uPaymentId: a2uData.a2uPaymentId,
          a2uTxid: a2uData.txid,
          a2uFromAddress: a2uData.fromAddress,
          a2uToAddress: a2uData.toAddress,
          horizonFeeCharged: a2uData.feeCharged,
          settledAt: new Date().toISOString(),
        })
      )
      console.log("[Pi Complete] ✓ Payment fully settled to merchant")

      return NextResponse.json({ status: "settled_to_merchant", paymentId })
    } else {
      console.error("[Pi Complete] DB transaction failed:", dbResult.error)
      
      // DB failed but A2U succeeded - recovery state already persisted
      // Mark requiresDbReconciliation so retry knows to complete DB only
      await redis.set(
        `payment:${paymentId}`,
        JSON.stringify({
          ...payment,
          status: "settlement_pending",
          a2uPaymentId: a2uData.a2uPaymentId,
          a2uTxid: a2uData.txid,
          a2uFromAddress: a2uData.fromAddress,
          a2uToAddress: a2uData.toAddress,
          horizonFeeCharged: a2uData.feeCharged,
          requiresDbReconciliation: true,
          dbError: dbResult.error,
        })
      )
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
