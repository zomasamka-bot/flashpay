import { type NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { redis, isRedisConfigured } from "@/lib/redis"
import { recordA2UTransactionAtomic } from "@/lib/db"
import { config } from "@/lib/config"
import { validateFinancialData } from "@/lib/financial-validation"
import { buildA2USuccessResponse } from "@/lib/a2u-response"

/**
 * Server-side recovery endpoint that performs DB reconciliation using trusted Redis data.
 * 
 * AUTHORIZATION:
 * - Requires x-flashpay-internal-secret header (server-to-server only)
 * - Fail-closed: no secret = 403 Forbidden
 * - No fallback to client-provided credentials
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

    // AUTHORIZATION: Verify internal secret (fail-closed, server-to-server only)
    const providedSecret = request.headers.get("x-flashpay-internal-secret")
    
    if (!providedSecret || !config.a2uInternalSecret) {
      console.error("[API Recovery] ❌ Missing internal secret header")
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 }
      )
    }

    // Timing-safe comparison (no early exit on mismatch)
    try {
      const secretBuffer = Buffer.from(config.a2uInternalSecret)
      const providedBuffer = Buffer.from(providedSecret)
      timingSafeEqual(secretBuffer, providedBuffer)
    } catch {
      console.error("[API Recovery] ❌ Secret validation failed")
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 }
      )
    }

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

      // STRICT: Validate ALL financial data before DB operation - NO FALLBACKS
      const validation = validateFinancialData(payment)
      if (!validation.success) {
        console.error("[API Recovery] ❌ Financial validation failed:", validation.error)
        return NextResponse.json(
          {
            error: "Financial data incomplete - manual review required",
            details: validation.error,
            status: "manual_review_required",
            paymentId,
          },
          { status: 400 }
        )
      }

      const financialData = validation.data

      try {
        // Call recordA2UTransactionAtomic with VALIDATED, authoritative financial data from Redis
        const dbResult = await recordA2UTransactionAtomic({
          u2aIdentifier: payment.u2aIdentifier || "",
          u2aTxid: financialData.u2aTxid,
          a2uIdentifier: payment.a2uIdentifier || "",
          a2uTxid: financialData.a2uTxid,
          merchantId: financialData.merchantId,
          merchantUid: financialData.merchantUid,
          customerAmount: financialData.customerAmount,
          merchantAmount: financialData.merchantAmount,
          horizonFeeCharged: financialData.horizonFeeCharged,
          appCommission: financialData.appCommission,
        })

        // CRITICAL: Check dbResult.success === true BEFORE marking settled_to_merchant
        if (!dbResult || !dbResult.success) {
          console.error("[API Recovery] ❌ DB reconciliation returned success=false:", dbResult?.error)
          // Keep payment in requiresDbReconciliation state - never clear flag on DB failure
          return NextResponse.json(
            {
              error: "Database reconciliation failed",
              details: dbResult?.error || "Unknown DB error",
              status: "manual_review_required",
              paymentId,
            },
            { status: 500 }
          )
        }

        // Only mark settled_to_merchant AFTER confirmed success
        const updatedPayment = {
          ...payment,
          status: "settled_to_merchant",
          requiresDbReconciliation: false,
          piCompleted: true,
          settlementCompletedAt: new Date().toISOString(),
        }

        await redis.set(paymentKey, JSON.stringify(updatedPayment))
        console.log("[API Recovery] ✅ State 2: DB reconciliation completed successfully with txid:", dbResult.transactionId)

        // Return canonical response from authoritative Redis checkpoint
        const canonicalResponse = await buildA2USuccessResponse(paymentId)
        if (!canonicalResponse) {
          console.error("[API Recovery] ❌ Failed to build canonical response for settled payment")
          return NextResponse.json(
            { error: "Response building failed - data corruption detected" },
            { status: 500 }
          )
        }
        return NextResponse.json(canonicalResponse)
      } catch (dbError) {
        console.error("[API Recovery] ❌ DB reconciliation threw error:", dbError)
        // Never clear reconciliation flag on exception
        return NextResponse.json(
          {
            error: "Failed to record transaction in database",
            details: String(dbError),
            status: "manual_review_required",
            paymentId,
          },
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

      // STRICT: Validate ALL financial data before DB operation - NO FALLBACKS
      const validation = validateFinancialData(payment)
      if (!validation.success) {
        console.error("[API Recovery] ❌ Financial validation failed:", validation.error)
        return NextResponse.json(
          {
            error: "Financial data incomplete - manual review required",
            details: validation.error,
            status: "manual_review_required",
            paymentId,
          },
          { status: 400 }
        )
      }

      const financialData = validation.data

      try {
        // Call recordA2UTransactionAtomic with VALIDATED, authoritative financial data from Redis
        const dbResult = await recordA2UTransactionAtomic({
          u2aIdentifier: payment.u2aIdentifier || "",
          u2aTxid: financialData.u2aTxid,
          a2uIdentifier: payment.a2uIdentifier || "",
          a2uTxid: financialData.a2uTxid,
          merchantId: financialData.merchantId,
          merchantUid: financialData.merchantUid,
          customerAmount: financialData.customerAmount,
          merchantAmount: financialData.merchantAmount,
          horizonFeeCharged: financialData.horizonFeeCharged,
          appCommission: financialData.appCommission,
        })

        // CRITICAL: Check dbResult.success === true BEFORE marking settled_to_merchant
        if (!dbResult || !dbResult.success) {
          console.error("[API Recovery] ❌ DB reconciliation returned success=false:", dbResult?.error)
          // Keep payment in piCompleted state, mark as requiring reconciliation on next attempt
          const updatedPayment = {
            ...payment,
            requiresDbReconciliation: true,
          }
          await redis.set(paymentKey, JSON.stringify(updatedPayment))
          
          return NextResponse.json(
            {
              error: "Database reconciliation failed",
              details: dbResult?.error || "Unknown DB error",
              status: "manual_review_required",
              paymentId,
            },
            { status: 500 }
          )
        }

        // Only mark settled_to_merchant AFTER confirmed success
        const updatedPayment = {
          ...payment,
          status: "settled_to_merchant",
          settlementCompletedAt: new Date().toISOString(),
        }

        await redis.set(paymentKey, JSON.stringify(updatedPayment))
        console.log("[API Recovery] ✅ State 4: DB-only reconciliation completed successfully with txid:", dbResult.transactionId)

        // Return canonical response from authoritative Redis checkpoint
        const canonicalResponse = await buildA2USuccessResponse(paymentId)
        if (!canonicalResponse) {
          console.error("[API Recovery] ❌ Failed to build canonical response for settled payment")
          return NextResponse.json(
            { error: "Response building failed - data corruption detected" },
            { status: 500 }
          )
        }
        return NextResponse.json(canonicalResponse)
      } catch (dbError) {
        console.error("[API Recovery] ❌ DB-only reconciliation threw error:", dbError)
        // Mark as requiring reconciliation so next attempt retries DB operation
        const updatedPayment = {
          ...payment,
          requiresDbReconciliation: true,
        }
        await redis.set(paymentKey, JSON.stringify(updatedPayment))
        
        return NextResponse.json(
          {
            error: "Failed to record transaction in database",
            details: String(dbError),
            status: "manual_review_required",
            paymentId,
          },
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
