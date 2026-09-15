import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { isPaymentFinal } from "@/lib/payment-status"
import { findRefundCheckpointByPaymentId } from "@/lib/refund-checkpoint-store"
import { isRedisConfigured, redis } from "@/lib/redis"
import type { Payment } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Verdict = "Final" | "Recovering" | "Manual Review" | "Conflict" | "Unknown"

function validPaymentId(value: string | null): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && value === value.trim() && /^[A-Za-z0-9_-]+$/.test(value)
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  const paymentId = new URL(request.url).searchParams.get("paymentId")
  if (!validPaymentId(paymentId)) return NextResponse.json({ error: "Invalid Payment ID" }, { status: 400 })
  if (!isRedisConfigured) return NextResponse.json({ verdict: "Unknown", paymentId, reason: "Canonical Redis unavailable" }, { status: 503 })

  let payment: Payment | null = null
  try {
    const raw = await redis.get<unknown>(`payment:${paymentId}`)
    if (raw) payment = (typeof raw === "string" ? JSON.parse(raw) : raw) as Payment
  } catch {
    return NextResponse.json({ verdict: "Unknown", paymentId, reason: "Canonical payment read failed" }, { status: 503 })
  }
  if (!payment) return NextResponse.json({ verdict: "Unknown", paymentId, reason: "Payment not found in canonical Redis" }, { status: 404 })
  if (payment.id !== paymentId) return NextResponse.json({ verdict: "Conflict", paymentId, reason: "Canonical payment identity mismatch" }, { status: 409 })

  const refund = await findRefundCheckpointByPaymentId(paymentId)
  let dbEvidence: { state: "present" | "absent" | "unknown"; transactionCount?: number; receiptCount?: number } = { state: "unknown" }
  try {
    const rows = await query(`SELECT
      (SELECT COUNT(*)::int FROM transactions WHERE payment_id=$1) AS transaction_count,
      (SELECT COUNT(*)::int FROM receipts WHERE payment_id=$1 OR u2a_identifier=$1) AS receipt_count`, [paymentId])
    const row = Array.isArray(rows) && rows.length === 1 && rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : null
    if (row) {
      const transactionCount = Number(row.transaction_count)
      const receiptCount = Number(row.receipt_count)
      if (Number.isSafeInteger(transactionCount) && Number.isSafeInteger(receiptCount)) dbEvidence = { state: transactionCount > 0 || receiptCount > 0 ? "present" : "absent", transactionCount, receiptCount }
    }
  } catch {}

  const settlementEvidence = Boolean(payment.a2uPaymentId || payment.a2uTxid || payment.a2uPreparedTxHash || payment.horizonSuccessFlag)
  const refundEvidence = refund.state === "present" || Boolean(payment.refundPaymentId || payment.refundTxid || (payment.refundStatus && payment.refundStatus !== "not_started"))
  let verdict: Verdict = "Unknown"
  let reason = "Evidence is insufficient for an automatic conclusion"
  if (settlementEvidence && refundEvidence) { verdict = "Conflict"; reason = "Settlement and refund evidence coexist; no action is permitted here" }
  else if (isPaymentFinal(payment)) { verdict = "Final"; reason = "Canonical finality proof is complete" }
  else if (refund.state === "uncertain" || dbEvidence.state === "unknown") { verdict = "Unknown"; reason = "One or more authoritative reads are uncertain" }
  else if (payment.status === "settlement_failed" && (payment.settlementFailureState === "manual_review_required" || payment.refundStatus === "manual_review_required")) { verdict = "Manual Review"; reason = "Canonical state requires manual review" }
  else if (payment.status === "paid_to_app" || payment.status === "settlement_pending" || payment.requiresDbReconciliation === true || payment.piCompletionPending === true || payment.refundStatus === "pending" || payment.refundStatus === "submitted") { verdict = "Recovering"; reason = "Canonical state is non-final and owned by existing recovery authorities" }
  else if (payment.status === "settlement_failed") { verdict = "Manual Review"; reason = "Settlement failed without a safe workbench action" }

  return NextResponse.json({
    paymentId, verdict, reason, asOf: new Date().toISOString(),
    canonical: {
      status: payment.status, settlementFailureState: payment.settlementFailureState ?? null,
      piPaymentId: payment.piPaymentId ?? null, u2aTxid: payment.u2aTxid ?? null,
      a2uPaymentId: payment.a2uPaymentId ?? null, a2uTxid: payment.a2uTxid ?? null,
      horizonSuccessFlag: payment.horizonSuccessFlag === true, piCompleted: payment.piCompleted === true,
      dbRecorded: payment.dbRecorded === true, requiresDbReconciliation: payment.requiresDbReconciliation === true,
      piCompletionPending: payment.piCompletionPending === true, refundStatus: payment.refundStatus ?? null,
      refundPaymentId: payment.refundPaymentId ?? null, refundTxid: payment.refundTxid ?? null,
      customerAmount: payment.customerAmount ?? payment.amount ?? null, merchantAmount: payment.merchantAmount ?? null,
      horizonFeeCharged: payment.horizonFeeCharged ?? null, appNetImpact: payment.appNetImpact ?? null,
    },
    database: dbEvidence,
    refund: refund.state === "present" ? { state: "present", status: refund.checkpoint.status, stage: refund.checkpoint.stage, refundId: refund.checkpoint.refundId } : { state: refund.state },
    action: { allowed: false, message: "Read-only workbench. Financial remediation remains exclusively behind existing Plan 7 executors, locks, and gates." },
  }, { headers: { "Cache-Control": "no-store" } })
}
