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
    `WITH requested AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_requested' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details->>'stage'='intent_created'
    ), confirmed AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_submission_confirmed' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5
    ), accounting AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      JOIN refund_accounting_records r ON r.refund_id=$1 AND r.payment_id=$2
        AND r.refund_payment_id=$4 AND r.refund_txid=$5 AND r.payer_uid=$6
        AND r.amount=$7::numeric AND r.currency=$8
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_accounting_recorded' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5
        AND a.details->>'horizonFeeStroops'=r.horizon_fee_stroops::text
    ), audit_recorded AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_audit_recorded' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5
    ), completed AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_type='refund_completed' AND a.actor_type='system' AND a.event_id <> ''
        AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5
    ), finalized AS (
      SELECT count(*)::int AS count, array_agg(a.created_at AT TIME ZONE 'UTC') AS times
      FROM refund_audit_events a
      WHERE a.refund_id=$1 AND a.payment_id=$2 AND a.idempotency_key=$3
        AND a.event_id='refund:'||$1||':projection_finalized'
        AND a.event_type='refund_projection_finalized' AND a.actor_type='system'
        AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5
    )
    SELECT
      (SELECT count FROM requested) AS requested_count,
      (SELECT times[1] FROM requested) AS requested_at,
      (SELECT count FROM confirmed) AS confirmed_count,
      (SELECT times[1] FROM confirmed) AS confirmation_recorded_at,
      (SELECT count FROM accounting) AS accounting_count,
      (SELECT times[1] FROM accounting) AS accounting_recorded_at,
      (SELECT count FROM audit_recorded) AS audit_count,
      (SELECT times[1] FROM audit_recorded) AS audit_recorded_at,
      (SELECT count FROM completed) AS completed_count,
      (SELECT times[1] FROM completed) AS completed_at,
      (SELECT count FROM finalized) AS finalized_count,
      (SELECT times[1] FROM finalized) AS finalized_at`,
    [
      checkpoint.refundId,
      checkpoint.paymentId,
      checkpoint.idempotencyKey,
      checkpoint.refundPaymentId ?? null,
      checkpoint.refundTxid ?? null,
      checkpoint.payerUid,
      checkpoint.amount,
      checkpoint.currency,
    ],
  )

  if (!Array.isArray(rows) || rows.length !== 1) return { outcome: 'INDETERMINATE' }
  const row = rows[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return { outcome: 'INDETERMINATE' }
  const record = row as Record<string, unknown>
  const countKeys = ['requested_count', 'confirmed_count', 'accounting_count', 'audit_count', 'completed_count', 'finalized_count']
  if (!countKeys.every((key) => record[key] === 0 || record[key] === 1)) return { outcome: 'INDETERMINATE' }

  const normalized = normalizeRefundPersistenceTimestamps({
    requestedAt: record.requested_at ?? null,
    confirmationRecordedAt: record.confirmation_recorded_at ?? null,
    accountingRecordedAt: record.accounting_recorded_at ?? null,
    auditRecordedAt: record.audit_recorded_at ?? null,
    completedAt: record.completed_at ?? null,
    finalizedAt: record.finalized_at ?? null,
  })
  if (normalized.outcome === 'INDETERMINATE') return normalized
  return normalized
}
