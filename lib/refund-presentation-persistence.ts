import 'server-only'

import { query } from './db'
import { normalizeRefundPersistenceTimestamps } from './refund-presentation'
import type {
  RefundCheckpoint,
  RefundPresentationPersistenceReadResult,
} from './types'

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
