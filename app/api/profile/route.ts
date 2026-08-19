import { type NextRequest, NextResponse } from "next/server"
import { getMerchantProfileSummary, getSettledPaymentIds, query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { readRefundPresentation } from "@/lib/refund-presentation-reader"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/profile?merchantId=xxx
 * Returns merchant profile summary with transaction statistics
 * SECURITY: Requires Bearer token with verified Pi identity matching merchantId
 */
export async function GET(request: NextRequest) {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    return NextResponse.json(
      { error: "Profile service not configured" },
      { status: 503 }
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // SECURITY: Verify merchant identity from Pi using Bearer token
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Profile API] Missing or invalid authorization header")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }
    
    if (verifiedMerchant.username !== merchantId) {
      console.warn("[Profile API] Unauthorized access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedMerchant.username,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    // Get merchant profile summary
    const profileSummary = await getMerchantProfileSummary(merchantId)

    if (!profileSummary) {
      return NextResponse.json(
        { error: "Failed to retrieve profile summary" },
        { status: 500 }
      )
    }

    const operationalPayments: Array<Record<string, unknown>> = []
    if (isRedisConfigured) {
      const keys = await redis.keys("payment:*")
      for (const key of keys || []) {
        try {
          const raw = await redis.get(key)
          if (!raw) continue
          const payment = typeof raw === "string" ? JSON.parse(raw) : raw
          if (!payment || payment.merchantId !== verifiedMerchant.username) continue
          if (["paid_to_app", "settlement_pending", "settlement_failed", "refund_pending", "refunded"].includes(payment.status) || payment.settlementFailureState) {
            const operationalPayment: Record<string, unknown> = {
              paymentId: payment.id,
              piPaymentId: payment.piPaymentId,
              amount: payment.customerAmount ?? payment.amount,
              status: payment.status,
              settlementFailureState: payment.settlementFailureState || "none",
              settlementFailureCode: payment.a2uErrorCode,
              heldAt: payment.paidAt,
              nextRetryAt: payment.nextRetryAt,
              refundStatus: payment.refundStatus || "not_started",
              refundPaymentId: payment.refundPaymentId,
              refundTxid: payment.refundTxid,
              u2aTxid: payment.u2aTxid,
              a2uPaymentId: payment.a2uPaymentId,
              a2uTxid: payment.a2uTxid,
              updatedAt: payment.lastAttemptAt || payment.paidAt || payment.createdAt,
            }
            const shouldReadRefund =
              ["settlement_failed", "refund_pending", "refunded"].includes(payment.status) ||
              ["refund_pending", "refunded"].includes(payment.settlementFailureState) ||
              ["pending", "submitted", "completed", "failed", "manual_review_required"].includes(payment.refundStatus)
            if (shouldReadRefund) {
              const checkpointRows = await query(
                "SELECT refund_id FROM refund_checkpoints WHERE payment_id=$1 LIMIT 2",
                [payment.id],
              )
              const checkpointRow = checkpointRows?.length === 1 ? checkpointRows[0] : null
              const refundId =
                typeof checkpointRow === "object" && checkpointRow !== null && !Array.isArray(checkpointRow) &&
                typeof (checkpointRow as Record<string, unknown>).refund_id === "string"
                  ? (checkpointRow as Record<string, unknown>).refund_id.trim()
                  : ""
              if (refundId) {
                const refundPresentation = await readRefundPresentation(refundId)
                if (refundPresentation.outcome === "FOUND" && refundPresentation.presentation.paymentId === payment.id) {
                  operationalPayment.refundPresentation = refundPresentation.presentation
                }
              }
            }
            operationalPayments.push(operationalPayment)
          }
        } catch (error) {
          console.warn("[Profile API] Skipping malformed operational payment", key, error)
        }
      }
    }

    const settledPaymentIds = await getSettledPaymentIds(
      verifiedMerchant.username,
      operationalPayments
        .map((payment) => payment.piPaymentId)
        .filter((paymentId): paymentId is string => typeof paymentId === "string" && paymentId.length > 0),
    )
    const authoritativeOperationalPayments = operationalPayments.filter(
      (payment) =>
        typeof payment.piPaymentId !== "string" || !settledPaymentIds.has(payment.piPaymentId),
    )

    return NextResponse.json({ ...profileSummary, operationalPayments: authoritativeOperationalPayments })
  } catch (error) {
    console.error("[Profile API] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
