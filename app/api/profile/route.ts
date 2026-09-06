import { type NextRequest, NextResponse } from "next/server"
import { getMerchantProfileSummary, getSettledPaymentIds, query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { readRefundPresentation } from "@/lib/refund-presentation-reader"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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
    const refundPaymentIds = new Set<string>()
    if (!isRedisConfigured) {
      return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    }
    let historyIds: unknown[]
    try {
      const bootstrapMarker = await redis.get("flashpay:merchant-history:v1:bootstrap")
      if (bootstrapMarker !== "done") return NextResponse.json({ error: "Operational payment history not ready" }, { status: 503 })
      historyIds = await redis.zrange<unknown[]>(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, 0, -1)
    } catch {
      return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    }
    const seen = new Set<string>()
    const validatedIds: string[] = []
    if (!Array.isArray(historyIds)) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    for (const id of historyIds) {
      if (typeof id !== "string" || id.length === 0 || id !== id.trim() || seen.has(id)) {
        return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
      }
      seen.add(id)
      validatedIds.push(id)
    }
    for (let index = 0; index < validatedIds.length; index += 200) {
      const batchIds = validatedIds.slice(index, index + 200)
      const batchKeys = batchIds.map((id) => `payment:${id}`)
      let values: unknown[]
      try {
        const batchValues = await redis.mget<unknown[]>(batchKeys)
        if (!Array.isArray(batchValues) || batchValues.length !== batchKeys.length) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
        values = batchValues
      } catch {
        return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
      }
      for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        const raw = values[valueIndex]
        let paymentValue: unknown
        try {
          paymentValue = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch {
          return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
        }
        if (!isRecord(paymentValue) || paymentValue.id !== batchIds[valueIndex] || paymentValue.merchantId !== verifiedMerchant.username) {
          return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
        }
        const payment = paymentValue
        const status = typeof payment.status === "string" ? payment.status : undefined
        const settlementFailureState = typeof payment.settlementFailureState === "string" ? payment.settlementFailureState : undefined
        const refundStatus = typeof payment.refundStatus === "string" ? payment.refundStatus : undefined
        if (["paid_to_app", "settlement_pending", "settlement_failed", "refund_pending", "refunded"].includes(status ?? "") || payment.settlementFailureState) {
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
              ["settlement_failed", "refund_pending", "refunded"].includes(status ?? "") ||
              ["refund_pending", "refunded"].includes(settlementFailureState ?? "") ||
              ["pending", "submitted", "completed", "failed", "manual_review_required"].includes(refundStatus ?? "")
            if (
              shouldReadRefund &&
              typeof payment.id === "string" &&
              payment.id.length > 0 &&
              payment.id === payment.id.trim()
            ) {
              refundPaymentIds.add(payment.id)
            }
            operationalPayments.push(operationalPayment)
          }
        }
      }

    const refundIdsByPaymentId = new Map<string, string>()
    const requestedRefundPaymentIds = [...refundPaymentIds]
    for (let index = 0; index < requestedRefundPaymentIds.length; index += 200) {
      const batchPaymentIds = requestedRefundPaymentIds.slice(index, index + 200)
      const placeholders = batchPaymentIds.map((_, batchIndex) => `$${batchIndex + 1}`).join(",")
      let checkpointRows: unknown
      try {
        checkpointRows = await query(`SELECT payment_id, refund_id FROM refund_checkpoints WHERE payment_id IN (${placeholders})`, batchPaymentIds)
      } catch {
        return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
      }
      if (!Array.isArray(checkpointRows)) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
      const batchRequested = new Set(batchPaymentIds)
      const batchSeen = new Set<string>()
      for (const row of checkpointRows) {
        if (!isRecord(row) || typeof row.payment_id !== "string" || !batchRequested.has(row.payment_id) || batchSeen.has(row.payment_id) || typeof row.refund_id !== "string" || row.refund_id.length === 0 || row.refund_id !== row.refund_id.trim()) {
          return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
        }
        batchSeen.add(row.payment_id)
        refundIdsByPaymentId.set(row.payment_id, row.refund_id)
      }
    }
    const refundCandidates: Array<{ payment: Record<string, unknown>; paymentId: string; refundId: string }> = []
    for (const payment of operationalPayments) {
      const paymentId = typeof payment.paymentId === "string" ? payment.paymentId : undefined
      const refundId = paymentId ? refundIdsByPaymentId.get(paymentId) : undefined
      if (paymentId === undefined || refundId === undefined) continue
      refundCandidates.push({ payment, paymentId, refundId })
    }
    for (let index = 0; index < refundCandidates.length; index += 2) {
      const chunk = refundCandidates.slice(index, index + 2)
      const results = await Promise.all(chunk.map(async (candidate) => ({
        candidate,
        result: await readRefundPresentation(candidate.refundId),
      })))
      for (const { candidate, result } of results) {
        if (result.outcome === "FOUND" && result.presentation.paymentId === candidate.paymentId) {
          candidate.payment.refundPresentation = result.presentation
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

    // Read-only correction overlay: completed refund presentations classify their
    // canonical transaction from exactly one settlement row, without changing the total.
    const overlaidPiPaymentIds = new Set<string>()
    const correctionPiPaymentIds: string[] = []
    const correctionPiPaymentIdSet = new Set<string>()
    for (const payment of authoritativeOperationalPayments) {
      const presentationValue: unknown = payment.refundPresentation
      if (
        typeof presentationValue !== "object" ||
        presentationValue === null ||
        Array.isArray(presentationValue)
      ) continue
      const presentation = presentationValue as Record<string, unknown>
      if (presentation.merchantStatus !== "refund_completed") continue
      if (presentation.paymentId !== payment.paymentId) continue
      if (typeof payment.piPaymentId !== "string" || payment.piPaymentId.length === 0) continue
      if (correctionPiPaymentIdSet.has(payment.piPaymentId)) continue
      correctionPiPaymentIdSet.add(payment.piPaymentId)
      correctionPiPaymentIds.push(payment.piPaymentId)
    }

    const correctionRowsByPaymentId = new Map<string, unknown[]>()
    for (let index = 0; index < correctionPiPaymentIds.length; index += 200) {
      const batchPaymentIds = correctionPiPaymentIds.slice(index, index + 200)
      const placeholders = batchPaymentIds.map((_, batchIndex) => `$${batchIndex + 2}`).join(",")
      const transactionRows = await query(
        `SELECT t.payment_id, t.id, t.amount, r.settlement_status
         FROM transactions t
         LEFT JOIN receipts r ON r.transaction_id = t.id
         WHERE t.merchant_id = $1 AND t.payment_id IN (${placeholders})`,
        [verifiedMerchant.username, ...batchPaymentIds],
      )
      if (!Array.isArray(transactionRows)) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
      for (const rowValue of transactionRows) {
        if (!isRecord(rowValue) || typeof rowValue.payment_id !== "string" || !correctionPiPaymentIdSet.has(rowValue.payment_id)) {
          return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
        }
        const rows = correctionRowsByPaymentId.get(rowValue.payment_id) ?? []
        rows.push(rowValue)
        correctionRowsByPaymentId.set(rowValue.payment_id, rows)
      }
    }

    for (const payment of authoritativeOperationalPayments) {
      const presentationValue: unknown = payment.refundPresentation
      if (
        typeof presentationValue !== "object" ||
        presentationValue === null ||
        Array.isArray(presentationValue)
      ) continue
      const presentation = presentationValue as Record<string, unknown>
      if (presentation.merchantStatus !== "refund_completed") continue
      if (presentation.paymentId !== payment.paymentId) continue
      if (typeof payment.piPaymentId !== "string" || payment.piPaymentId.length === 0) continue
      if (overlaidPiPaymentIds.has(payment.piPaymentId)) continue
      overlaidPiPaymentIds.add(payment.piPaymentId)
      const transactionRows = correctionRowsByPaymentId.get(payment.piPaymentId) ?? []
      if (transactionRows.length !== 1) continue

      const rowValue: unknown = transactionRows[0]
      if (!isRecord(rowValue)) continue
      const settlementStatus: unknown = rowValue.settlement_status
      if (typeof settlementStatus !== "string") continue
      if (settlementStatus === "failed" || settlementStatus === "settlement_failed") continue

      const amountValue: unknown = rowValue.amount
      const amount = typeof amountValue === "number"
        ? amountValue
        : typeof amountValue === "string"
          ? Number(amountValue)
          : Number.NaN
      if (!Number.isFinite(amount)) continue

      if (["settlement_pending", "paid_to_app", "pending"].includes(settlementStatus)) {
        profileSummary.pendingTransactions -= 1
        profileSummary.totalAwaitingAmount -= amount
      } else if (settlementStatus === "settled_to_merchant") {
        profileSummary.settledTransactions -= 1
        profileSummary.totalSettledAmount -= amount
      } else if (settlementStatus === "completed") {
        profileSummary.completedTransactions -= 1
        profileSummary.totalCompletedAmount -= amount
      } else {
        continue
      }

      profileSummary.failedTransactions += 1
      profileSummary.totalFailedAmount += amount
    }

    return NextResponse.json({ ...profileSummary, operationalPayments: authoritativeOperationalPayments })
  } catch (error) {
    console.error("[Profile API] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
