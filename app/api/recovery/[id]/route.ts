import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { redis, isRedisConfigured } from "@/lib/redis"
import { recordA2UTransactionAtomic } from "@/lib/db"

/**
 * Server-side recovery endpoint that performs DB reconciliation using trusted Redis data.
 * 
 * PRECISE RECOVERY ORDER:
 * 1. settled_to_merchant - Payment is already settled, return success
 * 2. requiresDbReconciliation + a2uTxid - Record A2U transaction in DB atomically
 * 3. settlement_pending + piCompletionPending - Retry only Pi /complete (not handled here)
 * 4. piCompleted + DB pending - Call recordA2UTransactionAtomic with Redis data
 * 5. settlement_failed - Only if no a2uTxid or horizonSuccessFlag (prevent restart)
 * 
 * CRITICAL RULES:
 * - Never restart Horizon when a2uTxid or horizonSuccessFlag exists
 * - Only use trusted Redis data for DB reconciliation
 * - DB operations only for states 2 and 4
 * - Client must never perform DB operations
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: paymentId } = await params

    console.log("[API Recovery] POST /api/recovery/[id] called for:", paymentId)

    if (!isRedisConfigured) {
      return NextResponse.json(
        { error: "Redis not configured" },
        { status: 500 }
      )
    }

    // Load complete payment state from Redis (trusted source)
    const paymentKey = `payment:${paymentId}`
    const paymentData = await redis.get(paymentKey)

    if (!paymentData) {
      console.error("[API Recovery] ❌ Payment not found in Redis:", paymentId)
      return NextResponse.json(
        { error: "Payment not found" },
        { status: 404 }
      )
    }

    const payment = JSON.parse(paymentData)
    console.log("[API Recovery] Payment status:", payment.status)
    console.log("[API Recovery] Payment flags:", {
      requiresDbReconciliation: payment.requiresDbReconciliation,
      horizonSuccessFlag: payment.horizonSuccessFlag,
      piCompletionPending: payment.piCompletionPending,
      piCompleted: payment.piCompleted,
      a2uTxid: payment.a2uTxid ? "present" : "missing",
    })

    // RECOVERY ORDER: Check states in exact sequence

    // 1) settled_to_merchant: Payment is already settled
    if (payment.status === "settled_to_merchant") {
      console.log("[API Recovery] ✅ State 1: settled_to_merchant - no recovery needed")
      return NextResponse.json({
        status: "settled_to_merchant",
        u2aTxid: payment.u2aTxid,
        a2uTxid: payment.a2uTxid,
      })
    }

    // 2) requiresDbReconciliation + a2uTxid: Record A2U transaction in DB
    if (payment.requiresDbReconciliation && payment.a2uTxid && payment.horizonSuccessFlag) {
      console.log("[API Recovery] 🔄 State 2: requiresDbReconciliation - recording A2U in DB")

      try {
        // Call recordA2UTransactionAtomic with trusted Redis data
        await recordA2UTransactionAtomic({
          u2aIdentifier: payment.u2aIdentifier || "",
          u2aTxid: payment.u2aTxid || "",
          a2uIdentifier: payment.a2uIdentifier || "",
          a2uTxid: payment.a2uTxid,
          merchantId: payment.merchantId,
          merchantUid: payment.merchantUid || "",
          customerAmount: payment.customerAmount || payment.amount,
          merchantAmount: payment.merchantAmount || payment.amount,
          horizonFeeCharged: payment.horizonFeeCharged || 0,
          appCommission: payment.appCommission || 0,
        })

        // Update payment status to settled_to_merchant
        const updatedPayment = {
          ...payment,
          status: "settled_to_merchant",
          requiresDbReconciliation: false,
          piCompleted: true,
          settledAt: new Date().toISOString(),
        }

        await redis.set(paymentKey, JSON.stringify(updatedPayment))
        console.log("[API Recovery] ✅ State 2: DB reconciliation completed")

        return NextResponse.json({
          status: "settled_to_merchant",
          u2aTxid: payment.u2aTxid,
          a2uTxid: payment.a2uTxid,
        })
      } catch (dbError) {
        console.error("[API Recovery] ❌ DB reconciliation failed:", dbError)
        return NextResponse.json(
          { error: "Failed to record transaction in database", details: String(dbError) },
          { status: 500 }
        )
      }
    }

    // 3) settlement_pending + piCompletionPending: Handled by client retry to /api/pi/complete
    if (payment.status === "settlement_pending" && payment.piCompletionPending) {
      console.log("[API Recovery] 🔁 State 3: settlement_pending - retry Pi /complete via client")
      return NextResponse.json(
        { error: "Retry Pi /complete endpoint from client" },
        { status: 400 }
      )
    }

    // 4) piCompleted + DB pending: DB reconciliation needed
    if (payment.piCompleted && !payment.requiresDbReconciliation && payment.a2uTxid && payment.horizonSuccessFlag) {
      console.log("[API Recovery] 📊 State 4: piCompleted + DB pending - DB-only reconciliation")

      try {
        await recordA2UTransactionAtomic({
          u2aIdentifier: payment.u2aIdentifier || "",
          u2aTxid: payment.u2aTxid || "",
          a2uIdentifier: payment.a2uIdentifier || "",
          a2uTxid: payment.a2uTxid,
          merchantId: payment.merchantId,
          merchantUid: payment.merchantUid || "",
          customerAmount: payment.customerAmount || payment.amount,
          merchantAmount: payment.merchantAmount || payment.amount,
          horizonFeeCharged: payment.horizonFeeCharged || 0,
          appCommission: payment.appCommission || 0,
        })

        const updatedPayment = {
          ...payment,
          status: "settled_to_merchant",
          settledAt: new Date().toISOString(),
        }

        await redis.set(paymentKey, JSON.stringify(updatedPayment))
        console.log("[API Recovery] ✅ State 4: DB-only reconciliation completed")

        return NextResponse.json({
          status: "settled_to_merchant",
          u2aTxid: payment.u2aTxid,
          a2uTxid: payment.a2uTxid,
        })
      } catch (dbError) {
        console.error("[API Recovery] ❌ DB-only reconciliation failed:", dbError)
        return NextResponse.json(
          { error: "Failed to record transaction in database", details: String(dbError) },
          { status: 500 }
        )
      }
    }

    // 5) settlement_failed: Never restart if a2uTxid or horizonSuccessFlag exists
    if (payment.status === "settlement_failed") {
      if (payment.a2uTxid || payment.horizonSuccessFlag) {
        console.log("[API Recovery] ❌ State 5: settlement_failed with a2uTxid/horizonSuccessFlag - no recovery")
        return NextResponse.json(
          { error: "Irreversible settlement failure - contact support" },
          { status: 400 }
        )
      }
      console.log("[API Recovery] 🔄 State 5: settlement_failed - may retry (no identifiers)")
      return NextResponse.json(
        { error: "Payment failed - client may retry" },
        { status: 400 }
      )
    }

    // No recovery path matched
    console.log("[API Recovery] ⚠️ No recovery path matched for status:", payment.status)
    return NextResponse.json(
      { error: "Unable to determine recovery action for this payment state" },
      { status: 400 }
    )
  } catch (error) {
    console.error("[API Recovery] Unexpected error:", error)
    return NextResponse.json(
      { error: "Recovery endpoint error", details: String(error) },
      { status: 500 }
    )
  }
}
