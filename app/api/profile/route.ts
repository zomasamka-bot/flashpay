import { type NextRequest, NextResponse } from "next/server"
import { getMerchantProfileSummary, getSettledPaymentIds, query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { readRefundPresentation } from "@/lib/refund-presentation-reader"
import { readRefundPresentationPersistences, readRefundPresentationProofs } from "@/lib/refund-presentation-persistence"
import { getRefundCheckpointsByPaymentIds } from "@/lib/refund-checkpoint-store"
import type { RefundCheckpoint, RefundPresentationPersistenceReadResult, RefundPresentationProofReadResult } from "@/lib/types"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const PROFILE_DISMISSED_REFUND_PREFIX = "flashpay:profile:dismissed-refund:v1"

function dismissedRefundKey(merchantId: string, paymentId: string): string {
  return `${PROFILE_DISMISSED_REFUND_PREFIX}:${merchantId}:${paymentId}`
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
      historyIds = await redis.zrange<unknown[]>(`flashpay:merchant:${verifiedMerchant.username}:payments:v1`, 0, 1000)
    } catch {
      return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    }
    const seen = new Set<string>()
    const validatedIds: string[] = []
    if (!Array.isArray(historyIds)) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    if (historyIds.length > 1000) return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
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

    const checkpointResult = await getRefundCheckpointsByPaymentIds([...refundPaymentIds])
    if (checkpointResult.state === "uncertain") return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    const refundIdsByPaymentId = new Map<string, string>()
    for (const checkpoint of checkpointResult.checkpoints.values()) refundIdsByPaymentId.set(checkpoint.paymentId, checkpoint.refundId)
    const completedCheckpoints = [...checkpointResult.checkpoints.values()].filter((checkpoint) => checkpoint.stage === "audit_recorded" && checkpoint.status === "completed")
    const persistenceResult = await readRefundPresentationPersistences(completedCheckpoints)
    if (persistenceResult.state === "uncertain") return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    const proofResult = await readRefundPresentationProofs(completedCheckpoints)
    if (proofResult.state === "uncertain") return NextResponse.json({ error: "Operational payment history unavailable" }, { status: 503 })
    const refundCandidates: Array<{ payment: Record<string, unknown>; paymentId: string; refundId: string; checkpoint: RefundCheckpoint | undefined; proof: { refundId: string; paymentId: string; idempotencyKey: string; result: RefundPresentationProofReadResult } | undefined; persistence: { refundId: string; paymentId: string; idempotencyKey: string; result: RefundPresentationPersistenceReadResult } | undefined }> = []
    for (const payment of operationalPayments) {
      const paymentId = typeof payment.paymentId === "string" ? payment.paymentId : undefined
      const refundId = paymentId ? refundIdsByPaymentId.get(paymentId) : undefined
      if (paymentId === undefined || refundId === undefined) continue
      const checkpoint = checkpointResult.checkpoints.get(paymentId)
      const proofResultForPayment = checkpoint && checkpoint.stage === "audit_recorded" && checkpoint.status === "completed" ? proofResult.proofs.get(checkpoint.refundId) : undefined
      const proof = checkpoint && proofResultForPayment ? { refundId: checkpoint.refundId, paymentId: checkpoint.paymentId, idempotencyKey: checkpoint.idempotencyKey, result: proofResultForPayment } : undefined
      const persistenceValue = checkpoint && checkpoint.stage === "audit_recorded" && checkpoint.status === "completed" ? persistenceResult.persistences.get(checkpoint.refundId) : undefined
      const persistence = checkpoint && persistenceValue ? { refundId: checkpoint.refundId, paymentId: checkpoint.paymentId, idempotencyKey: checkpoint.idempotencyKey, result: persistenceValue } : undefined
      refundCandidates.push({ payment, paymentId, refundId, checkpoint, proof, persistence })
    }
    for (let index = 0; index < refundCandidates.length; index += 2) {
      const chunk = refundCandidates.slice(index, index + 2)
      const results = await Promise.all(chunk.map(async (candidate) => ({
        candidate,
        result: await readRefundPresentation(
          candidate.refundId,
          candidate.checkpoint && candidate.checkpoint.stage === "audit_recorded" && candidate.checkpoint.status === "completed" ? candidate.checkpoint : undefined,
          candidate.proof,
          candidate.persistence,
        ),
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

    // K7 presentation-only dismissal. This projection is intentionally applied
    // after all accounting corrections so hiding a completed refund from the
    // merchant workspace cannot change financial totals, evidence, or search.
    const completedRefundPaymentIds = authoritativeOperationalPayments
      .filter((payment) => {
        const presentation = payment.refundPresentation
        return isRecord(presentation) && presentation.merchantStatus === "refund_completed" && presentation.paymentId === payment.paymentId
      })
      .map((payment) => payment.paymentId)
      .filter((paymentId): paymentId is string => typeof paymentId === "string" && paymentId.length > 0)

    const dismissedRefundPaymentIds = new Set<string>()
    for (let index = 0; index < completedRefundPaymentIds.length; index += 200) {
      const batchIds = completedRefundPaymentIds.slice(index, index + 200)
      let markers: unknown[]
      try {
        const values = await redis.mget<unknown[]>(batchIds.map((paymentId) => dismissedRefundKey(verifiedMerchant.username, paymentId)))
        if (!Array.isArray(values) || values.length !== batchIds.length) return NextResponse.json({ error: "Profile presentation unavailable" }, { status: 503 })
        markers = values
      } catch {
        return NextResponse.json({ error: "Profile presentation unavailable" }, { status: 503 })
      }
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
        const marker = markers[markerIndex]
        if (marker !== null && marker !== "dismissed") return NextResponse.json({ error: "Profile presentation unavailable" }, { status: 503 })
        if (marker === "dismissed") dismissedRefundPaymentIds.add(batchIds[markerIndex])
      }
    }

    const visibleOperationalPayments = authoritativeOperationalPayments.filter((payment) => {
      const paymentId = typeof payment.paymentId === "string" ? payment.paymentId : ""
      return !dismissedRefundPaymentIds.has(paymentId)
    })

    return NextResponse.json({ ...profileSummary, operationalPayments: visibleOperationalPayments })
  } catch (error) {
    console.error("[Profile API] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/profile
 * Presentation-only dismissal for a completed refund. Never mutates the
 * canonical payment, refund checkpoint, Horizon proof, accounting, or audit.
 */
export async function POST(request: NextRequest) {
  if (!isRedisConfigured) return NextResponse.json({ error: "Profile presentation unavailable" }, { status: 503 })

  try {
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    if (!verifiedMerchant) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const body: unknown = await request.json()
    if (!isRecord(body)) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

    const merchantId = body.merchantId
    const paymentId = body.paymentId
    const action = body.action
    if (
      typeof merchantId !== "string" || merchantId.length === 0 || merchantId !== merchantId.trim() || merchantId !== verifiedMerchant.username ||
      typeof paymentId !== "string" || paymentId.length === 0 || paymentId.length > 128 || paymentId !== paymentId.trim() ||
      action !== "dismiss_completed_refund"
    ) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    const rawPayment = await redis.get(`payment:${paymentId}`)
    let paymentValue: unknown
    try {
      paymentValue = typeof rawPayment === "string" ? JSON.parse(rawPayment) : rawPayment
    } catch {
      return NextResponse.json({ error: "Payment unavailable" }, { status: 503 })
    }
    if (!isRecord(paymentValue) || paymentValue.id !== paymentId || paymentValue.merchantId !== verifiedMerchant.username) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    // Only a fully projected completed refund can be dismissed from Profile.
    // This gate is presentation-only and does not alter the payment itself.
    if (
      paymentValue.status !== "refunded" ||
      paymentValue.refundStatus !== "completed" ||
      paymentValue.settlementFailureState !== "refunded"
    ) {
      return NextResponse.json({ error: "Only completed refunds can be removed from Profile" }, { status: 409 })
    }

    await redis.set(dismissedRefundKey(verifiedMerchant.username, paymentId), "dismissed")
    const marker = await redis.get(dismissedRefundKey(verifiedMerchant.username, paymentId))
    if (marker !== "dismissed") return NextResponse.json({ error: "Profile presentation unavailable" }, { status: 503 })

    return NextResponse.json({ paymentId, dismissed: true })
  } catch (error) {
    console.error("[Profile API] Presentation dismissal error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
