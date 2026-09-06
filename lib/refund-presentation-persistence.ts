import 'server-only'

import { query } from './db'
import { normalizeRefundBlockchainTransactionAt, normalizeRefundPersistenceTimestamps } from './refund-presentation'
import type {
  RefundCheckpoint,
  RefundPresentationBlockchainReadResult,
  RefundPresentationPersistenceReadResult,
  RefundPresentationProofReadResult,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readRefundPresentationPersistence(
  checkpoint: RefundCheckpoint,
): Promise<RefundPresentationPersistenceReadResult> {
  const rows = await query(
    `WITH requested_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_requested'
    ), requested_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_requested' AND a.actor_type='system' AND a.event_id <> ''
        AND (a.details = jsonb_build_object('stage','intent_created')
          OR a.details = jsonb_build_object('resumed',true))
    ), confirmed_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_submission_confirmed'
    ), confirmed_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_submission_confirmed' AND a.actor_type='system' AND a.event_id <> ''
        AND (a.details = jsonb_build_object('refundPaymentId',$4::text,'refundTxid',$5::text)
          OR a.details = jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'recovered',true))
    ), accounting_total AS (
      SELECT count(*)::int AS total
      FROM refund_accounting_records r
      WHERE r.refund_id=$1 OR r.payment_id=$2 OR r.refund_payment_id=$4 OR r.refund_txid=$5
    ), accounting_exact AS (
      SELECT count(*)::int AS exact, max(r.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_accounting_records r
      WHERE r.refund_id=$1 AND r.payment_id=$2 AND r.refund_payment_id=$4
        AND r.refund_txid=$5 AND r.payer_uid=$6 AND r.amount=$7::numeric AND r.currency=$8
    ), accounting_event_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_accounting_recorded'
    ), accounting_event_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      JOIN refund_accounting_records r ON r.refund_id=$1 AND r.payment_id=$2 AND r.refund_payment_id=$4
        AND r.refund_txid=$5 AND r.payer_uid=$6 AND r.amount=$7::numeric AND r.currency=$8
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_accounting_recorded' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details = jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'horizonFeeStroops',r.horizon_fee_stroops)
    ), audit_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_audit_recorded'
    ), audit_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      JOIN refund_accounting_records r ON r.refund_id=$1 AND r.payment_id=$2 AND r.refund_payment_id=$4
        AND r.refund_txid=$5 AND r.payer_uid=$6 AND r.amount=$7::numeric AND r.currency=$8
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_audit_recorded' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details = jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'horizonFeeStroops',r.horizon_fee_stroops)
    ), completed_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_completed'
    ), completed_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      JOIN refund_accounting_records r ON r.refund_id=$1 AND r.payment_id=$2 AND r.refund_payment_id=$4
        AND r.refund_txid=$5 AND r.payer_uid=$6 AND r.amount=$7::numeric AND r.currency=$8
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_completed' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details = jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'horizonFeeStroops',r.horizon_fee_stroops)
    ), finalized_total AS (
      SELECT count(*)::int AS total
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.event_type='refund_projection_finalized'
    ), finalized_exact AS (
      SELECT count(*)::int AS exact, max(a.created_at AT TIME ZONE 'UTC') AS created_at
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_id='refund:'||$1||':projection_finalized'
        AND a.event_type='refund_projection_finalized' AND a.actor_type='system'
        AND a.details = jsonb_build_object('refundPaymentId',$4,'refundTxid',$5)
    )
    SELECT
      (SELECT total FROM requested_total) requested_total,
      (SELECT exact FROM requested_exact) requested_exact,
      (SELECT created_at FROM requested_exact) requested_at,
      (SELECT total FROM confirmed_total) confirmed_total,
      (SELECT exact FROM confirmed_exact) confirmed_exact,
      (SELECT created_at FROM confirmed_exact) confirmation_recorded_at,
      (SELECT total FROM accounting_event_total) accounting_event_total,
      (SELECT exact FROM accounting_event_exact) accounting_event_exact,
      (SELECT total FROM accounting_total) accounting_total,
      (SELECT exact FROM accounting_exact) accounting_exact,
      (SELECT created_at FROM accounting_exact) accounting_recorded_at,
      (SELECT total FROM audit_total) audit_total,
      (SELECT exact FROM audit_exact) audit_exact,
      (SELECT created_at FROM audit_exact) audit_recorded_at,
      (SELECT total FROM completed_total) completed_total,
      (SELECT exact FROM completed_exact) completed_exact,
      (SELECT created_at FROM completed_exact) completed_at,
      (SELECT total FROM finalized_total) finalized_total,
      (SELECT exact FROM finalized_exact) finalized_exact,
      (SELECT created_at FROM finalized_exact) finalized_at`,
    [checkpoint.refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.refundPaymentId ?? null, checkpoint.refundTxid ?? null, checkpoint.payerUid, checkpoint.amount, checkpoint.currency],
  )

  if (!Array.isArray(rows) || rows.length !== 1) return { outcome: 'INDETERMINATE' }
  const row = rows[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return { outcome: 'INDETERMINATE' }
  const record = row as Record<string, unknown>
  const sources = [
    ['requested_total', 'requested_exact'], ['confirmed_total', 'confirmed_exact'],
    ['accounting_event_total', 'accounting_event_exact'], ['accounting_total', 'accounting_exact'], ['audit_total', 'audit_exact'],
    ['completed_total', 'completed_exact'], ['finalized_total', 'finalized_exact'],
  ] as const
  if (!sources.every(([total, exact]) => Number.isInteger(record[total]) && Number.isInteger(record[exact]) && (record[total] as number) <= 1 && record[total] === record[exact])) return { outcome: 'INDETERMINATE' }

  const normalized = normalizeRefundPersistenceTimestamps({
    requestedAt: record.requested_at,
    confirmationRecordedAt: record.confirmation_recorded_at,
    accountingRecordedAt: record.accounting_recorded_at,
    auditRecordedAt: record.audit_recorded_at,
    completedAt: record.completed_at,
    finalizedAt: record.finalized_at,
  })
  return normalized
}

export async function readRefundPresentationPersistences(
  checkpoints: RefundCheckpoint[],
): Promise<{ state: 'ok'; persistences: Map<string, RefundPresentationPersistenceReadResult> } | { state: 'uncertain' }> {
  const valid = checkpoints.filter((checkpoint) => checkpoint.stage === 'audit_recorded' && checkpoint.status === 'completed')
  const seenRefundIds = new Set<string>()
  const seenPaymentIds = new Set<string>()
  const seenRefundPaymentIds = new Set<string>()
  const seenRefundTxids = new Set<string>()
  for (const checkpoint of valid) {
    const refundId = checkpoint.refundId
    const paymentId = checkpoint.paymentId
    const refundPaymentId = checkpoint.refundPaymentId
    const refundTxid = checkpoint.refundTxid
    if (
      typeof refundId !== 'string' || refundId.length === 0 || refundId !== refundId.trim() || seenRefundIds.has(refundId) ||
      typeof paymentId !== 'string' || paymentId.length === 0 || paymentId !== paymentId.trim() || seenPaymentIds.has(paymentId) ||
      typeof refundPaymentId !== 'string' || refundPaymentId.length === 0 || refundPaymentId !== refundPaymentId.trim() || seenRefundPaymentIds.has(refundPaymentId) ||
      typeof refundTxid !== 'string' || refundTxid.length === 0 || refundTxid !== refundTxid.trim() || seenRefundTxids.has(refundTxid)
    ) return { state: 'uncertain' }
    seenRefundIds.add(refundId)
    seenPaymentIds.add(paymentId)
    seenRefundPaymentIds.add(refundPaymentId)
    seenRefundTxids.add(refundTxid)
  }
  const persistences = new Map<string, RefundPresentationPersistenceReadResult>()
  if (valid.length === 0) return { state: 'ok', persistences }
  let rows: unknown
  try {
    rows = await query(`WITH input AS (
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[]) WITH ORDINALITY AS t(refund_id,payment_id,idempotency_key,refund_payment_id,refund_txid,payer_uid,amount,currency,ordinality)
    )
    SELECT i.ordinality, i.refund_id, i.payment_id, i.idempotency_key,
      x.requested_total, x.requested_exact, x.requested_at, x.confirmed_total, x.confirmed_exact, x.confirmation_recorded_at,
      x.accounting_event_total, x.accounting_event_exact, x.accounting_total, x.accounting_exact, x.accounting_recorded_at,
      x.audit_total, x.audit_exact, x.audit_recorded_at, x.completed_total, x.completed_exact, x.completed_at,
      x.finalized_total, x.finalized_exact, x.finalized_at
    FROM input i
    CROSS JOIN LATERAL (
      WITH requested AS (SELECT count(*)::int total, count(*) FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.actor_type='system' AND a.event_id<>'' AND (a.details=jsonb_build_object('stage','intent_created') OR a.details=jsonb_build_object('resumed',true)))::int exact, max(a.created_at AT TIME ZONE 'UTC') FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.actor_type='system' AND a.event_id<>'' AND (a.details=jsonb_build_object('stage','intent_created') OR a.details=jsonb_build_object('resumed',true))) created_at FROM refund_audit_events a WHERE a.refund_id=i.refund_id AND a.event_type='refund_requested'),
      confirmed AS (SELECT count(*)::int total, count(*) FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.actor_type='system' AND a.event_id<>'' AND (a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid) OR a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid,'recovered',true)))::int exact, max(a.created_at AT TIME ZONE 'UTC') FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.actor_type='system' AND a.event_id<>'' AND (a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid) OR a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid,'recovered',true))) created_at FROM refund_audit_events a WHERE a.refund_id=i.refund_id AND a.event_type='refund_submission_confirmed'),
      accounting AS (SELECT count(*) FILTER (WHERE r.refund_id=i.refund_id AND r.payment_id=i.payment_id AND r.refund_payment_id=i.refund_payment_id AND r.refund_txid=i.refund_txid AND r.payer_uid=i.payer_uid AND r.amount=i.amount AND r.currency=i.currency)::int exact, count(*) FILTER (WHERE r.refund_id=i.refund_id OR r.payment_id=i.payment_id OR r.refund_payment_id=i.refund_payment_id OR r.refund_txid=i.refund_txid)::int total, max(r.created_at AT TIME ZONE 'UTC') FILTER (WHERE r.refund_id=i.refund_id AND r.payment_id=i.payment_id AND r.refund_payment_id=i.refund_payment_id AND r.refund_txid=i.refund_txid AND r.payer_uid=i.payer_uid AND r.amount=i.amount AND r.currency=i.currency) created_at FROM refund_accounting_records r),
      events AS (SELECT e.event_type, count(*)::int total, count(*) FILTER (WHERE e.payment_id=i.payment_id AND e.idempotency_key=i.idempotency_key AND e.actor_type='system' AND e.event_id<>'' AND e.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid,'horizonFeeStroops',r.horizon_fee_stroops))::int exact, max(e.created_at AT TIME ZONE 'UTC') FILTER (WHERE e.payment_id=i.payment_id AND e.idempotency_key=i.idempotency_key AND e.actor_type='system' AND e.event_id<>'' AND e.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid,'horizonFeeStroops',r.horizon_fee_stroops)) created_at FROM refund_audit_events e LEFT JOIN refund_accounting_records r ON r.refund_id=i.refund_id AND r.payment_id=i.payment_id AND r.refund_payment_id=i.refund_payment_id AND r.refund_txid=i.refund_txid AND r.payer_uid=i.payer_uid AND r.amount=i.amount AND r.currency=i.currency WHERE e.refund_id=i.refund_id AND e.event_type IN ('refund_accounting_recorded','refund_audit_recorded','refund_completed','refund_projection_finalized') GROUP BY e.event_type),
      finalized AS (SELECT count(*) FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.event_id='refund:'||i.refund_id||':projection_finalized' AND a.actor_type='system' AND a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid))::int exact, count(*)::int total, max(a.created_at AT TIME ZONE 'UTC') FILTER (WHERE a.payment_id=i.payment_id AND a.idempotency_key=i.idempotency_key AND a.event_id='refund:'||i.refund_id||':projection_finalized' AND a.actor_type='system' AND a.details=jsonb_build_object('refundPaymentId',i.refund_payment_id,'refundTxid',i.refund_txid)) created_at FROM refund_audit_events a WHERE a.refund_id=i.refund_id AND a.event_type='refund_projection_finalized')
      SELECT requested.total requested_total, requested.exact requested_exact, requested.created_at requested_at, confirmed.total confirmed_total, confirmed.exact confirmed_exact, confirmed.created_at confirmation_recorded_at, COALESCE((SELECT total FROM events WHERE event_type='refund_accounting_recorded'),0) accounting_event_total, COALESCE((SELECT exact FROM events WHERE event_type='refund_accounting_recorded'),0) accounting_event_exact, accounting.total accounting_total, accounting.exact accounting_exact, accounting.created_at accounting_recorded_at, COALESCE((SELECT total FROM events WHERE event_type='refund_audit_recorded'),0) audit_total, COALESCE((SELECT exact FROM events WHERE event_type='refund_audit_recorded'),0) audit_exact, (SELECT created_at FROM events WHERE event_type='refund_audit_recorded') audit_recorded_at, COALESCE((SELECT total FROM events WHERE event_type='refund_completed'),0) completed_total, COALESCE((SELECT exact FROM events WHERE event_type='refund_completed'),0) completed_exact, (SELECT created_at FROM events WHERE event_type='refund_completed') completed_at, finalized.total finalized_total, finalized.exact finalized_exact, finalized.created_at finalized_at FROM requested, confirmed, accounting, finalized
    ) x ORDER BY i.ordinality`, [valid.map((c) => c.refundId), valid.map((c) => c.paymentId), valid.map((c) => c.idempotencyKey), valid.map((c) => c.refundPaymentId), valid.map((c) => c.refundTxid), valid.map((c) => c.payerUid), valid.map((c) => c.amount), valid.map((c) => c.currency)])
  } catch {
    return { state: 'uncertain' }
  }
  if (!Array.isArray(rows) || rows.length !== valid.length) return { state: 'uncertain' }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!isRecord(row) || row.ordinality !== index + 1 || row.refund_id !== valid[index].refundId || row.payment_id !== valid[index].paymentId || row.idempotency_key !== valid[index].idempotencyKey) return { state: 'uncertain' }
    const sources = [['requested_total', 'requested_exact'], ['confirmed_total', 'confirmed_exact'], ['accounting_event_total', 'accounting_event_exact'], ['accounting_total', 'accounting_exact'], ['audit_total', 'audit_exact'], ['completed_total', 'completed_exact'], ['finalized_total', 'finalized_exact']] as const
    if (!sources.every(([total, exact]) => {
      const totalValue = row[total]
      const exactValue = row[exact]
      return typeof totalValue === 'number' && Number.isInteger(totalValue) && typeof exactValue === 'number' && Number.isInteger(exactValue) && totalValue <= 1 && totalValue === exactValue
    })) return { state: 'uncertain' }
    persistences.set(valid[index].refundId, normalizeRefundPersistenceTimestamps({ requestedAt: row.requested_at, confirmationRecordedAt: row.confirmation_recorded_at, accountingRecordedAt: row.accounting_recorded_at, auditRecordedAt: row.audit_recorded_at, completedAt: row.completed_at, finalizedAt: row.finalized_at }))
  }
  return { state: 'ok', persistences }
}

function validateRefundPresentationProofRow(
  checkpoint: RefundCheckpoint,
  row: unknown,
): RefundPresentationProofReadResult {
  const refundPaymentId = checkpoint.refundPaymentId
  const refundTxid = checkpoint.refundTxid
  if (typeof refundPaymentId !== 'string' || refundPaymentId.length === 0 || refundPaymentId !== refundPaymentId.trim() || typeof refundTxid !== 'string' || refundTxid.length === 0 || refundTxid !== refundTxid.trim()) return { outcome: 'INDETERMINATE' }
  if (!isRecord(row) || row.event_id !== `refund:${checkpoint.refundId}:presentation_proof` || row.payment_id !== checkpoint.paymentId || row.idempotency_key !== checkpoint.idempotencyKey || row.actor_type !== 'system' || !isRecord(row.details)) return { outcome: 'INDETERMINATE' }
  const details = row.details
  const keys = Object.keys(details)
  if (keys.length !== 7 || keys.some((key) => !['refundPaymentId', 'refundTxid', 'transactionAt', 'network', 'piTransactionVerified', 'piDeveloperCompleted', 'horizonSuccessful'].includes(key))) return { outcome: 'INDETERMINATE' }
  if (details.refundPaymentId !== refundPaymentId || details.refundTxid !== refundTxid || details.network !== 'Pi Testnet' || details.piTransactionVerified !== true || details.piDeveloperCompleted !== true || details.horizonSuccessful !== true || typeof details.transactionAt !== 'string') return { outcome: 'INDETERMINATE' }
  const transactionAt = normalizeRefundBlockchainTransactionAt(details.transactionAt)
  if (!transactionAt) return { outcome: 'INDETERMINATE' }
  return { outcome: 'FOUND', proof: { refundPaymentId, refundTxid, transactionAt, network: 'Pi Testnet', piTransactionVerified: true, piDeveloperCompleted: true, horizonSuccessful: true } }
}

export async function readRefundPresentationProofs(
  checkpoints: RefundCheckpoint[],
): Promise<{ state: 'ok'; proofs: Map<string, RefundPresentationProofReadResult> } | { state: 'uncertain' }> {
  const validCheckpoints = checkpoints.filter((checkpoint) => checkpoint.stage === 'audit_recorded' && checkpoint.status === 'completed')
  const refundIds: string[] = []
  const byRefundId = new Map<string, RefundCheckpoint>()
  const seenRefundIds = new Set<string>()
  for (const checkpoint of validCheckpoints) {
    const refundId = checkpoint.refundId
    const paymentId = checkpoint.paymentId
    const idempotencyKey = checkpoint.idempotencyKey
    const refundPaymentId = checkpoint.refundPaymentId
    const refundTxid = checkpoint.refundTxid
    if (typeof refundId !== 'string' || refundId.length === 0 || refundId !== refundId.trim() || typeof paymentId !== 'string' || paymentId.length === 0 || paymentId !== paymentId.trim() || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey !== idempotencyKey.trim() || typeof refundPaymentId !== 'string' || refundPaymentId.length === 0 || refundPaymentId !== refundPaymentId.trim() || typeof refundTxid !== 'string' || refundTxid.length === 0 || refundTxid !== refundTxid.trim() || seenRefundIds.has(refundId)) return { state: 'uncertain' }
    seenRefundIds.add(refundId)
    refundIds.push(refundId)
    byRefundId.set(refundId, checkpoint)
  }
  const proofs = new Map<string, RefundPresentationProofReadResult>()
  if (refundIds.length === 0) return { state: 'ok', proofs }
  let rows: unknown
  try {
    rows = await query(`SELECT event_id, refund_id, payment_id, idempotency_key, actor_type, details FROM refund_audit_events WHERE refund_id = ANY($1::text[]) AND event_type='refund_presentation_proof_recorded' LIMIT ${refundIds.length + 1}`, [refundIds])
  } catch {
    return { state: 'uncertain' }
  }
  if (!Array.isArray(rows)) return { state: 'uncertain' }
  const seen = new Set<string>()
  for (const row of rows) {
    if (!isRecord(row) || typeof row.refund_id !== 'string' || !byRefundId.has(row.refund_id) || seen.has(row.refund_id)) return { state: 'uncertain' }
    seen.add(row.refund_id)
    const checkpoint = byRefundId.get(row.refund_id)
    if (!checkpoint) return { state: 'uncertain' }
    const result = validateRefundPresentationProofRow(checkpoint, row)
    if (result.outcome === 'INDETERMINATE') return { state: 'uncertain' }
    proofs.set(row.refund_id, result)
  }
  for (const refundId of refundIds) if (!proofs.has(refundId)) proofs.set(refundId, { outcome: 'ABSENT' })
  return { state: 'ok', proofs }
}

export async function readRefundPresentationProof(
  checkpoint: RefundCheckpoint,
): Promise<RefundPresentationProofReadResult> {
  if (
    checkpoint.stage !== 'audit_recorded' ||
    checkpoint.status !== 'completed' ||
    typeof checkpoint.refundId !== 'string' || checkpoint.refundId.length === 0 || checkpoint.refundId !== checkpoint.refundId.trim() ||
    typeof checkpoint.paymentId !== 'string' || checkpoint.paymentId.length === 0 || checkpoint.paymentId !== checkpoint.paymentId.trim() ||
    typeof checkpoint.idempotencyKey !== 'string' || checkpoint.idempotencyKey.length === 0 || checkpoint.idempotencyKey !== checkpoint.idempotencyKey.trim() ||
    typeof checkpoint.refundPaymentId !== 'string' || checkpoint.refundPaymentId.length === 0 || checkpoint.refundPaymentId !== checkpoint.refundPaymentId.trim() ||
    typeof checkpoint.refundTxid !== 'string' || checkpoint.refundTxid.length === 0 || checkpoint.refundTxid !== checkpoint.refundTxid.trim()
  ) return { outcome: 'INDETERMINATE' }
  const refundId = checkpoint.refundId
  const paymentId = checkpoint.paymentId
  const idempotencyKey = checkpoint.idempotencyKey
  const refundPaymentId = checkpoint.refundPaymentId
  const refundTxid = checkpoint.refundTxid
  let proofRows: unknown
  try {
    proofRows = await query(`SELECT event_id, payment_id, idempotency_key, actor_type, details FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_presentation_proof_recorded' LIMIT 2`, [refundId])
  } catch {
    return { outcome: 'INDETERMINATE' }
  }
  if (!Array.isArray(proofRows)) return { outcome: 'INDETERMINATE' }
  if (proofRows.length === 0) return { outcome: 'ABSENT' }
  if (proofRows.length !== 1) return { outcome: 'INDETERMINATE' }
  return validateRefundPresentationProofRow(checkpoint, proofRows[0])
}

export async function recordRefundPresentationProof(
  checkpoint: RefundCheckpoint,
  blockchain: RefundPresentationBlockchainReadResult,
): Promise<boolean> {
  if (
    checkpoint.stage !== 'audit_recorded' ||
    checkpoint.status !== 'completed' ||
    typeof checkpoint.refundId !== 'string' || checkpoint.refundId.length === 0 || checkpoint.refundId !== checkpoint.refundId.trim() ||
    typeof checkpoint.paymentId !== 'string' || checkpoint.paymentId.length === 0 || checkpoint.paymentId !== checkpoint.paymentId.trim() ||
    typeof checkpoint.idempotencyKey !== 'string' || checkpoint.idempotencyKey.length === 0 || checkpoint.idempotencyKey !== checkpoint.idempotencyKey.trim() ||
    typeof checkpoint.refundPaymentId !== 'string' || checkpoint.refundPaymentId.length === 0 || checkpoint.refundPaymentId !== checkpoint.refundPaymentId.trim() ||
    typeof checkpoint.refundTxid !== 'string' || checkpoint.refundTxid.length === 0 || checkpoint.refundTxid !== checkpoint.refundTxid.trim() ||
    blockchain.outcome !== 'CONFIRMED' ||
    blockchain.network !== 'Pi Testnet' ||
    blockchain.piTransactionVerified !== true ||
    blockchain.piDeveloperCompleted !== true ||
    blockchain.horizonSuccessful !== true
  ) return false
  const refundId = checkpoint.refundId
  const paymentId = checkpoint.paymentId
  const idempotencyKey = checkpoint.idempotencyKey
  const refundPaymentId = checkpoint.refundPaymentId
  const refundTxid = checkpoint.refundTxid
  const transactionAt = normalizeRefundBlockchainTransactionAt(blockchain.transactionAt)
  if (!transactionAt) return false
  try {
    const checkpointRows = await query(`SELECT payment_id, idempotency_key, status, stage, refund_payment_id, refund_txid FROM refund_checkpoints WHERE refund_id=$1 LIMIT 2`, [refundId])
    if (!Array.isArray(checkpointRows) || checkpointRows.length !== 1 || !isRecord(checkpointRows[0])) return false
    const checkpointRow = checkpointRows[0]
    if (checkpointRow.payment_id !== paymentId || checkpointRow.idempotency_key !== idempotencyKey || checkpointRow.status !== 'completed' || checkpointRow.stage !== 'audit_recorded' || checkpointRow.refund_payment_id !== refundPaymentId || checkpointRow.refund_txid !== refundTxid) return false
    const persistence = await readRefundPresentationPersistence(checkpoint)
    if (persistence.outcome !== 'FOUND' || Object.values(persistence.timestamps).some((value) => value === null)) return false
    const eventId = `refund:${refundId}:presentation_proof`
    const details = { refundPaymentId, refundTxid, transactionAt, network: 'Pi Testnet', piTransactionVerified: true, piDeveloperCompleted: true, horizonSuccessful: true }
    const inserted = await query(`INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details) VALUES ($1,$2,$3,'refund_presentation_proof_recorded','system',$4,NOW(),$5::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, refundId, paymentId, idempotencyKey, details])
    if (!Array.isArray(inserted) || inserted.length > 1) return false
    const readback = await readRefundPresentationProof(checkpoint)
    return readback.outcome === 'FOUND'
  } catch {
    return false
  }
}
