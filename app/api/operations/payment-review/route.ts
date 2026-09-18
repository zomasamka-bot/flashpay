import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { isPaymentFinal } from "@/lib/payment-status"
import { findRefundCheckpointByPaymentId } from "@/lib/refund-checkpoint-store"
import { isRedisConfigured, redis } from "@/lib/redis"
import type { Payment } from "@/lib/types"
import { appendOperationalQueueAuditEvent } from "@/lib/operational-audit"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Verdict = "Final" | "Recovering" | "Manual Review" | "Conflict" | "Unknown"
const ACTIVE_KEY = "flashpay:recovery:active-payments:v1"
const DISMISSED_KEY = "flashpay:operations:review-dismissed:v1"

function validPaymentId(value: string | null): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && value === value.trim() && /^[A-Za-z0-9_-]+$/.test(value)
}

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const REVIEW_CONCURRENCY = 8

function parsePageLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_PAGE_LIMIT
  if (!/^[0-9]+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_LIMIT ? parsed : null
}

function parseScanCursor(value: string | null): string | null {
  if (value === null || value === "") return "0"
  return /^[0-9]+$/.test(value) ? value : null
}

async function scanActivePaymentIds(cursor: string, limit: number): Promise<{ nextCursor: string; ids: string[] }> {
  const result = await redis.eval<[string], [string, string[]]>(
    "local r=redis.call('SSCAN',KEYS[1],ARGV[1],'COUNT',ARGV[2]); return {r[1],r[2]}",
    [ACTIVE_KEY],
    [cursor, String(limit)],
  )
  if (!Array.isArray(result) || result.length !== 2) throw new Error("Invalid active recovery scan result")
  const nextCursor = String(result[0])
  const rawIds = result[1]
  if (!/^[0-9]+$/.test(nextCursor) || !Array.isArray(rawIds)) throw new Error("Invalid active recovery scan result")
  return { nextCursor, ids: rawIds.filter((id): id is string => typeof id === "string" && validPaymentId(id)) }
}

async function mapBounded<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await mapper(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

async function readPayment(paymentId: string): Promise<Payment | null> {
  const raw = await redis.get<unknown>(`payment:${paymentId}`)
  if (!raw) return null
  const payment = (typeof raw === "string" ? JSON.parse(raw) : raw) as Payment
  return payment && payment.id === paymentId ? payment : null
}

async function buildReview(payment: Payment) {
  const paymentId = payment.id
  const refund = await findRefundCheckpointByPaymentId(paymentId)
  let dbEvidence: { state: "present" | "absent" | "unknown"; transactionCount?: number; receiptCount?: number; merchantUid?: string | null; payerUsername?: string | null } = { state: "unknown" }
  try {
    const rows = await query(`SELECT
      (SELECT COUNT(*)::int FROM transactions WHERE payment_id=$1) AS transaction_count,
      (SELECT COUNT(*)::int FROM receipts r JOIN transactions t ON t.id=r.transaction_id WHERE t.payment_id=$1 OR r.u2a_identifier=$1) AS receipt_count,
      (SELECT merchant_uid FROM transactions WHERE payment_id=$1 LIMIT 1) AS merchant_uid,
      (SELECT r.payer_username FROM receipts r JOIN transactions t ON t.id=r.transaction_id WHERE t.payment_id=$1 LIMIT 1) AS payer_username`, [paymentId])
    const row = Array.isArray(rows) && rows.length === 1 && rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : null
    if (row) {
      const transactionCount = Number(row.transaction_count), receiptCount = Number(row.receipt_count)
      if (Number.isSafeInteger(transactionCount) && Number.isSafeInteger(receiptCount)) dbEvidence = { state: transactionCount > 0 || receiptCount > 0 ? "present" : "absent", transactionCount, receiptCount, merchantUid: typeof row.merchant_uid === "string" ? row.merchant_uid : null, payerUsername: typeof row.payer_username === "string" ? row.payer_username : null }
    }
  } catch {}

  const settlementEvidence = Boolean(payment.a2uPaymentId || payment.a2uTxid || payment.a2uPreparedTxHash || payment.horizonSuccessFlag)
  const refundEvidence = refund.state === "present" || Boolean(payment.refundPaymentId || payment.refundTxid || (payment.refundStatus && payment.refundStatus !== "not_started"))
  let verdict: Verdict = "Unknown", reason = "Evidence is insufficient for an automatic conclusion"
  if (settlementEvidence && refundEvidence) { verdict = "Conflict"; reason = "Settlement and refund evidence coexist; financial action is blocked" }
  else if (isPaymentFinal(payment)) { verdict = "Final"; reason = "Canonical finality proof is complete" }
  else if (refund.state === "uncertain" || dbEvidence.state === "unknown") { verdict = "Unknown"; reason = "One or more authoritative reads are uncertain" }
  else if (payment.status === "settlement_failed" && (payment.settlementFailureState === "manual_review_required" || payment.refundStatus === "manual_review_required")) { verdict = "Manual Review"; reason = "Canonical state requires manual review" }
  else if (payment.status === "paid_to_app" || payment.status === "settlement_pending" || payment.requiresDbReconciliation === true || payment.piCompletionPending === true || payment.refundStatus === "pending" || payment.refundStatus === "submitted") { verdict = "Recovering"; reason = "Non-final state is owned by existing recovery authorities" }
  else if (payment.status === "settlement_failed") { verdict = "Manual Review"; reason = "Settlement failed without a proven safe manual action" }

  return { paymentId, verdict, reason, asOf: new Date().toISOString(), createdAt: payment.createdAt, updatedAt: payment.lastAttemptAt ?? payment.settledAt ?? payment.paidAt ?? payment.createdAt,
    parties: { merchantId: payment.merchantId, merchantUid: payment.merchantUid ?? dbEvidence.merchantUid ?? null, merchantAddress: payment.merchantAddress ?? null, payerUid: payment.payerUid ?? null, payerUsername: payment.payerUsername ?? dbEvidence.payerUsername ?? null },
    canonical: { status: payment.status, settlementFailureState: payment.settlementFailureState ?? null, piPaymentId: payment.piPaymentId ?? null, u2aTxid: payment.u2aTxid ?? null, a2uPaymentId: payment.a2uPaymentId ?? null, a2uTxid: payment.a2uTxid ?? null, horizonSuccessFlag: payment.horizonSuccessFlag === true, piCompleted: payment.piCompleted === true, dbRecorded: payment.dbRecorded === true, requiresDbReconciliation: payment.requiresDbReconciliation === true, piCompletionPending: payment.piCompletionPending === true, refundStatus: payment.refundStatus ?? null, refundPaymentId: payment.refundPaymentId ?? null, refundTxid: payment.refundTxid ?? null, customerAmount: payment.customerAmount ?? payment.amount ?? null, merchantAmount: payment.merchantAmount ?? null, horizonFeeCharged: payment.horizonFeeCharged ?? null, appNetImpact: payment.appNetImpact ?? null, retryCount: payment.retryCount ?? null, nextRetryAt: payment.nextRetryAt ?? null, lastErrorCode: payment.a2uErrorCode ?? payment.refundFailureCode ?? null, lastErrorMessage: payment.a2uErrorMessage ?? null },
    database: dbEvidence, refund: refund.state === "present" ? { state: "present", status: refund.checkpoint.status, stage: refund.checkpoint.stage, refundId: refund.checkpoint.refundId, refundPaymentId: refund.checkpoint.refundPaymentId ?? null, refundTxid: refund.checkpoint.refundTxid ?? null, amount: refund.checkpoint.amount, attemptCount: refund.checkpoint.attemptCount, lastErrorCode: refund.checkpoint.lastErrorCode ?? null, lastErrorMessage: refund.checkpoint.lastErrorMessage ?? null, updatedAt: refund.checkpoint.updatedAt } : { state: refund.state },
    action: {
      allowed: false,
      canPruneFromQueue: (payment.status === "cancelled" || payment.status === "failed") && !payment.paidAt && !payment.u2aTxid && !payment.a2uPaymentId && !payment.a2uTxid && payment.horizonSuccessFlag !== true && payment.piCompleted !== true && payment.dbRecorded !== true && !payment.refundPaymentId && !payment.refundTxid && refund.state === "absent",
      message: verdict === "Final" ? "No action required." : verdict === "Recovering" ? "Recovery is automatic. Manual execution is intentionally unavailable while the authoritative recovery path owns this payment." : "No financial action is exposed until the existing Plan 7 authority can prove a safe transition. Unknown/conflict always fails closed."
    } }
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!isRedisConfigured) return NextResponse.json({ error: "Canonical Redis unavailable", available: false }, { status: 503 })
  const url = new URL(request.url), paymentId = url.searchParams.get("paymentId")
  try {
    if (paymentId) {
      if (!validPaymentId(paymentId)) return NextResponse.json({ error: "Invalid Payment ID" }, { status: 400 })
      const payment = await readPayment(paymentId)
      if (!payment) return NextResponse.json({ verdict: "Unknown", paymentId, reason: "Payment not found in canonical Redis" }, { status: 404 })
      return NextResponse.json(await buildReview(payment), { headers: { "Cache-Control": "no-store" } })
    }
    const limit = parsePageLimit(url.searchParams.get("limit"))
    const cursor = parseScanCursor(url.searchParams.get("cursor"))
    if (limit === null) return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}` }, { status: 400 })
    if (cursor === null) return NextResponse.json({ error: "cursor must be an unsigned Redis SSCAN cursor" }, { status: 400 })

    const [activeIndexedRaw, scanned] = await Promise.all([
      redis.scard(ACTIVE_KEY),
      scanActivePaymentIds(cursor, limit),
    ])
    const activeIndexed = Number(activeIndexedRaw)
    if (!Number.isSafeInteger(activeIndexed) || activeIndexed < 0) throw new Error("Invalid active recovery cardinality")

    const reviews = (await mapBounded(scanned.ids, REVIEW_CONCURRENCY, async id => {
      try {
        const payment = await readPayment(id)
        return payment ? await buildReview(payment) : null
      } catch {
        return null
      }
    })).filter((review): review is NonNullable<typeof review> => Boolean(review))

    // Dismissal is checked only for this bounded page; never materialize the full dismissed set.
    const dismissalFlags = await mapBounded(reviews, REVIEW_CONCURRENCY, async review => {
      try { return Number(await redis.sismember(DISMISSED_KEY, review.paymentId)) === 1 } catch { throw new Error("Dismissed review index unavailable") }
    })
    const visible = reviews.filter((review, index) => !dismissalFlags[index] && (review.verdict !== "Final" || review.refund.state === "present")).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return NextResponse.json({
      available: true,
      asOf: new Date().toISOString(),
      items: visible,
      counts: {
        total: visible.length,
        recovering: visible.filter(x=>x.verdict==="Recovering").length,
        manualReview: visible.filter(x=>x.verdict==="Manual Review").length,
        conflicts: visible.filter(x=>x.verdict==="Conflict").length,
        unknown: visible.filter(x=>x.verdict==="Unknown").length,
        refunds: visible.filter(x=>x.refund.state==="present").length,
      },
      visibility: {
        activeIndexed,
        scanned: scanned.ids.length,
        pageVisible: visible.length,
        cursor,
        nextCursor: scanned.nextCursor,
        complete: scanned.nextCursor === "0",
        limit,
        concurrency: REVIEW_CONCURRENCY,
      },
      note: scanned.nextCursor !== "0" ? "More active recovery records are available; continue with nextCursor." : null,
    }, { headers: { "Cache-Control": "no-store" } })
  } catch { return NextResponse.json({ error: "Operational review unavailable", available: false }, { status: 503 }) }
}


export async function POST(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!isRedisConfigured) return NextResponse.json({ error: "Canonical Redis unavailable" }, { status: 503 })
  try {
    const body = await request.json() as { action?: unknown; paymentId?: unknown }
    if ((body.action !== "prune_terminal" && body.action !== "dismiss_reviewed") || typeof body.paymentId !== "string" || !validPaymentId(body.paymentId)) {
      return NextResponse.json({ error: "Invalid operator action" }, { status: 400 })
    }
    const payment = await readPayment(body.paymentId)
    if (!payment) return NextResponse.json({ error: "Canonical payment not found" }, { status: 404 })
    const refund = await findRefundCheckpointByPaymentId(payment.id)
    if (body.action === "dismiss_reviewed") {
      const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID()
      await redis.sadd(DISMISSED_KEY, payment.id)
      await appendOperationalQueueAuditEvent({ actorUid: auth.uid, requestId, paymentId: payment.id, action: "queue.dismiss_reviewed", reason: "Owner dismissed a reviewed payment from the Operations console only; recovery indexes and financial evidence were not changed" })
      return NextResponse.json({ success: true, paymentId: payment.id, dismissed: true, requestId }, { headers: { "Cache-Control": "no-store" } })
    }
    const safeTerminal = (payment.status === "cancelled" || payment.status === "failed") &&
      !payment.paidAt && !payment.u2aTxid && !payment.a2uPaymentId && !payment.a2uTxid && !payment.a2uPreparedTxHash &&
      payment.horizonSuccessFlag !== true && payment.piCompleted !== true && payment.dbRecorded !== true &&
      !payment.refundPaymentId && !payment.refundTxid && refund.state === "absent"
    if (!safeTerminal) {
      return NextResponse.json({ error: "Queue removal is blocked because terminal no-movement evidence is not proven" }, { status: 409 })
    }
    const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID()
    const removed = await redis.eval<[string], number>(
      "local a=redis.call('SREM',KEYS[1],ARGV[1]); local r=redis.call('ZREM',KEYS[2],ARGV[1]); if a==1 or r==1 then return 1 end; return 0",
      [ACTIVE_KEY, "flashpay:settlement:ready:v1"],
      [payment.id],
    )
    if (removed !== 0 && removed !== 1) return NextResponse.json({ error: "Invalid queue removal result" }, { status: 503 })
    await appendOperationalQueueAuditEvent({ actorUid: auth.uid, requestId, paymentId: payment.id, action: "queue.prune_terminal", reason: "Owner removed a proven terminal no-movement payment from operational recovery indexes" })
    return NextResponse.json({ success: true, paymentId: payment.id, removed: removed === 1, requestId }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Operator action unavailable" }, { status: 503 })
  }
}
