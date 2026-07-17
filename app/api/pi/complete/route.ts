import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordA2UTransactionAtomic } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const INTERNAL_SECRET = process.env.FLASHPAY_INTERNAL_SECRET || "flashpay-internal-secret-key"

/**
 * POST /api/pi/complete
 * 
 * SECURITY: This endpoint accepts ONLY paymentId + x-flashpay-internal-secret header.
 * All trusted settlement data (amount, merchant, txid, addresses, fees) comes ONLY from Redis.
 * 
 * Flow:
 * 1. Verify internal secret header (prevents external callers from triggering A2U)
 * 2. Get payment state from Redis (canonical source of truth)
 * 3. If status=paid_to_app: call A2U endpoint
 * 4. If A2U success: save A2U identifiers & fees to Redis, mark settlement_pending
 * 5. If DB commit succeeds: mark settled_to_merchant
 * 
 * Retries:
 * - settlement_pending: reattempt A2U but reuse same a2uPaymentId (no new A2U)
 * - settlement_failed: manual review needed or retry via complete endpoint
 */
export async function POST(request: NextRequest) {
  console.log("[Pi Complete] Request received at", new Date().toISOString())

  try {
    // 1. SECURITY: Verify internal secret header
    const internalSecret = request.headers.get("x-flashpay-internal-secret")
    if (internalSecret !== INTERNAL_SECRET) {
      console.warn("[Pi Complete] Unauthorized - invalid or missing secret header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 2. Parse request - accept ONLY paymentId
    const body = await request.json()
    const paymentId = body.paymentId
    
    if (!paymentId) {
      console.error("[Pi Complete] Missing paymentId")
      return NextResponse.json({ error: "Missing paymentId" }, { status: 400 })
    }

    console.log("[Pi Complete] Processing paymentId:", paymentId)

    // 3. Get canonical payment state from Redis
    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    const paymentData = await redis.get(`payment:${paymentId}`)
    if (!paymentData) {
      console.error("[Pi Complete] Payment not found in Redis:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
    console.log("[Pi Complete] Payment status:", payment.status)

    // 4. Handle retry cases and idempotency
    if (payment.status === "settled_to_merchant") {
      console.log("[Pi Complete] Already settled - returning current state")
      return NextResponse.json({
        status: "settled_to_merchant",
        paymentId,
        a2uTxid: payment.a2uTxid,
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
          "x-flashpay-internal-secret": INTERNAL_SECRET,
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

    // 5. Handle paid_to_app - start A2U settlement
    if (payment.status !== "paid_to_app") {
      console.error("[Pi Complete] Unexpected status:", payment.status)
      return NextResponse.json(
        { error: "Invalid payment status for completion", status: payment.status },
        { status: 400 }
      )
    }

    console.log("[Pi Complete] Starting A2U settlement for payment:", paymentId)

    // Call A2U endpoint with ONLY paymentId + secret
    const a2uResponse = await fetch(`${config.appUrl}/api/pi/a2u`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flashpay-internal-secret": INTERNAL_SECRET,
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

    // A2U succeeded - atomically record to DB with fee data
    console.log("[Pi Complete] A2U succeeded, recording atomic transaction")
    console.log("[Pi Complete] Horizon txid:", a2uData.txid)
    console.log("[Pi Complete] Horizon fee charged:", a2uData.feeCharged)

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
      
      // CRITICAL: Only mark settled AFTER DB commit
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

      return NextResponse.json({ status: "settled_to_merchant", paymentId })
    } else {
      console.error("[Pi Complete] DB transaction failed:", dbResult.error)
      
      // DB failed but A2U succeeded - atomic recovery state
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
