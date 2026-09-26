import { NextRequest, NextResponse } from "next/server"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { executeRefundNextStep } from "@/lib/refund-executor"
import { getRefundCheckpointReadOnly } from "@/lib/refund-checkpoint-store"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }
const LIVE_CONFIRM = "DR11_CONCURRENT_REFUND"
const READINESS_CONFIRM = "READINESS_ONLY"
const MAX_ROUNDS = 8
const CONTENDERS = 2

function authError(status: 401 | 403 | 500 | 503) {
  return status === 500 ? "Owner verification not configured" : status === 503 ? "Owner verification unavailable" : "Unauthorized"
}

function canonicalRefundId(value: unknown): string | null {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && value === value.trim() && /^[A-Za-z0-9-]+$/.test(value) ? value : null
}

export async function POST(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: authError(auth.status) }, { status: auth.status, headers: NO_STORE })
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_DR11_LIVE_CONCURRENT_REFUND_TEST !== "1") {
    return NextResponse.json({ error: "DR11 live certification disabled" }, { status: 403, headers: NO_STORE })
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const refundId = canonicalRefundId(body?.refundId)
  const confirmation = body?.confirmation
  if (!refundId || (confirmation !== LIVE_CONFIRM && confirmation !== READINESS_CONFIRM)) {
    return NextResponse.json({ error: "Exact DR11 refundId and confirmation required" }, { status: 400, headers: NO_STORE })
  }

  const before = await getRefundCheckpointReadOnly(refundId)
  if (before.state !== "present") return NextResponse.json({ error: "DR11 refund checkpoint unavailable" }, { status: 409, headers: NO_STORE })
  const cp = before.checkpoint
  const safeBefore = { refundId: cp.refundId, paymentId: cp.paymentId, stage: cp.stage, status: cp.status, amount: cp.amount, refundPaymentId: cp.refundPaymentId ?? null, refundTxid: cp.refundTxid ?? null }
  console.warn("[DR11 LIVE CONCURRENT REFUND] owner request", { ownerUid: auth.uid, mode: confirmation, ...safeBefore })

  if (confirmation === READINESS_CONFIRM) {
    return NextResponse.json({ success: true, mode: "readiness", contenders: CONTENDERS, checkpoint: safeBefore, financialExecutionStarted: false }, { status: 200, headers: NO_STORE })
  }
  if (cp.status !== "pending" || cp.stage !== "intent_created" || cp.refundPaymentId || cp.refundTxid) {
    return NextResponse.json({ error: "DR11 live start state must be pristine intent_created", checkpoint: safeBefore }, { status: 409, headers: NO_STORE })
  }
  if (cp.lastErrorCode !== "dr11_live_hold" || cp.lastErrorMessage !== "awaiting_owner_concurrent_harness" || typeof cp.nextRetryAt !== "string") {
    return NextResponse.json({ error: "DR11 owner hold missing or inconsistent", checkpoint: safeBefore }, { status: 409, headers: NO_STORE })
  }
  const releasedRows = await query(`
    UPDATE refund_checkpoints
    SET last_error_code=NULL, last_error_message=NULL, next_retry_at=NULL, updated_at=NOW()
    WHERE refund_id=$1 AND stage='intent_created' AND status='pending'
      AND refund_payment_id IS NULL AND refund_txid IS NULL
      AND last_error_code='dr11_live_hold' AND last_error_message='awaiting_owner_concurrent_harness'
      AND next_retry_at>NOW()
    RETURNING refund_id, payment_id, stage, status, refund_payment_id, refund_txid`, [refundId])
  const released = Array.isArray(releasedRows) && releasedRows.length === 1 ? releasedRows[0] as Record<string, unknown> : null
  if (!released || released.refund_id !== refundId || released.payment_id !== cp.paymentId || released.stage !== "intent_created" || released.status !== "pending" || released.refund_payment_id !== null || released.refund_txid !== null) {
    return NextResponse.json({ error: "DR11 owner hold release failed" }, { status: 503, headers: NO_STORE })
  }

  const rounds: Array<{ round: number; beforeStage: string; outcomes: unknown[]; afterStage: string; afterStatus: string }> = []
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pre = await getRefundCheckpointReadOnly(refundId)
    if (pre.state !== "present") return NextResponse.json({ error: "DR11 checkpoint became unavailable", rounds }, { status: 503, headers: NO_STORE })
    if (pre.checkpoint.stage === "audit_recorded" && pre.checkpoint.status === "completed") break
    if (pre.checkpoint.status !== "pending") return NextResponse.json({ error: "DR11 checkpoint left pending lifecycle", rounds }, { status: 409, headers: NO_STORE })

    // Same event-loop barrier: both contenders are created before either result is awaited.
    const contenders = Array.from({ length: CONTENDERS }, () => executeRefundNextStep(refundId))
    const outcomes = await Promise.all(contenders)
    const post = await getRefundCheckpointReadOnly(refundId)
    if (post.state !== "present") return NextResponse.json({ error: "DR11 post-round checkpoint unavailable", rounds }, { status: 503, headers: NO_STORE })
    rounds.push({ round, beforeStage: pre.checkpoint.stage, outcomes, afterStage: post.checkpoint.stage, afterStatus: post.checkpoint.status })
    console.warn("[DR11 LIVE CONCURRENT REFUND] round", { refundId, round, beforeStage: pre.checkpoint.stage, outcomes, afterStage: post.checkpoint.stage, afterStatus: post.checkpoint.status })
  }

  const completedBeforeProjection = await getRefundCheckpointReadOnly(refundId)
  if (completedBeforeProjection.state !== "present" || completedBeforeProjection.checkpoint.stage !== "audit_recorded" || completedBeforeProjection.checkpoint.status !== "completed") {
    return NextResponse.json({ error: "DR11 financial lifecycle did not reach completed audit", rounds }, { status: 409, headers: NO_STORE })
  }
  // Financial movement is already complete. This single normal executor call performs
  // only the terminal projection/audit finalization; it is deliberately not concurrent.
  const projectionFinalization = await executeRefundNextStep(refundId)
  if (projectionFinalization.outcome !== "found") {
    return NextResponse.json({ error: "DR11 terminal projection finalization failed", rounds, projectionFinalization }, { status: 409, headers: NO_STORE })
  }

  const after = await getRefundCheckpointReadOnly(refundId)
  if (after.state !== "present") return NextResponse.json({ error: "DR11 final checkpoint unavailable", rounds }, { status: 503, headers: NO_STORE })
  const final = after.checkpoint
  const proofRows = await query(`
    SELECT
      (SELECT count(*)::int FROM refund_checkpoints WHERE payment_id=$1) AS payment_refund_checkpoint_count,
      (SELECT count(*)::int FROM refund_accounting_records WHERE payment_id=$1) AS payment_refund_accounting_count,
      (SELECT count(DISTINCT refund_payment_id)::int FROM refund_accounting_records WHERE payment_id=$1) AS distinct_refund_payment_ids,
      (SELECT count(DISTINCT refund_txid)::int FROM refund_accounting_records WHERE payment_id=$1) AS distinct_refund_txids,
      (SELECT count(*)::int FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_blockchain_submission_started') AS blockchain_submission_started_events,
      (SELECT count(*)::int FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_completed') AS refund_completed_events,
      (SELECT count(*)::int FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_projection_finalized') AS refund_projection_finalized_events,
      (SELECT count(*)::int FROM settlement_checkpoints WHERE payment_id=$1 AND a2u_txid IS NOT NULL) AS settlement_movement_rows`,
    [final.paymentId, refundId],
  )
  const proof = Array.isArray(proofRows) && proofRows.length === 1 ? proofRows[0] as Record<string, unknown> : null
  const closed = final.stage === "audit_recorded" && final.status === "completed" && typeof final.refundPaymentId === "string" && !!final.refundPaymentId && typeof final.refundTxid === "string" && /^[0-9a-f]{64}$/.test(final.refundTxid) &&
    proof !== null && Number(proof.payment_refund_checkpoint_count) === 1 && Number(proof.payment_refund_accounting_count) === 1 && Number(proof.distinct_refund_payment_ids) === 1 && Number(proof.distinct_refund_txids) === 1 && Number(proof.blockchain_submission_started_events) === 1 && Number(proof.refund_completed_events) === 1 && Number(proof.refund_projection_finalized_events) === 1 && Number(proof.settlement_movement_rows) === 0

  console.warn("[DR11 LIVE CONCURRENT REFUND] final proof", { refundId, paymentId: final.paymentId, stage: final.stage, status: final.status, refundPaymentId: final.refundPaymentId ?? null, refundTxid: final.refundTxid ?? null, proof, closed })
  return NextResponse.json({ success: closed, certification: closed ? "DR11_LIVE_PASS" : "DR11_LIVE_NOT_CLOSED", contenders: CONTENDERS, rounds, final: { refundId, paymentId: final.paymentId, stage: final.stage, status: final.status, amount: final.amount, refundPaymentId: final.refundPaymentId ?? null, refundTxid: final.refundTxid ?? null }, proof }, { status: closed ? 200 : 409, headers: NO_STORE })
}
