import { redis, isRedisConfigured } from './redis'
import { query } from './db'
import type { RefundAuditEvent, RefundCheckpoint } from './types'

const redisKey = (refundId: string) => `flashpay:refund:checkpoint:${refundId}`
const redisLockKey = (idempotencyKey: string) => `flashpay:refund:idempotency:${idempotencyKey}`

export async function verifyRefundTables(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    const result = await query(`
      SELECT to_regclass('public.refund_checkpoints') AS checkpoints,
             to_regclass('public.refund_audit_events') AS audits
    `)
    const row = Array.isArray(result) && result.length > 0 ? result[0] as Record<string, unknown> : null
    return Boolean(row?.checkpoints && row?.audits)
  } catch {
    return false
  }
}

/**
 * Phase 2 persistence boundary. Database is authoritative; Redis is a fast
 * recovery mirror and idempotency claim. No wallet operation belongs here.
 */
export async function createRefundCheckpoint(checkpoint: RefundCheckpoint): Promise<RefundCheckpoint | null> {
  if (!process.env.DATABASE_URL) return null

  const result = await query(
    `INSERT INTO refund_checkpoints
      (refund_id, payment_id, idempotency_key, status, stage, payer_uid,
       payer_uid_verified_at, amount, currency, source_payment_status,
       source_settlement_state, created_at, updated_at, attempt_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (payment_id) DO NOTHING
     RETURNING *`,
    [
      checkpoint.refundId,
      checkpoint.paymentId,
      checkpoint.idempotencyKey,
      checkpoint.status,
      checkpoint.stage,
      checkpoint.payerUid,
      checkpoint.payerUidVerifiedAt,
      checkpoint.amount,
      checkpoint.currency,
      checkpoint.sourcePaymentStatus,
      checkpoint.sourceSettlementState,
      checkpoint.createdAt,
      checkpoint.updatedAt,
      checkpoint.attemptCount,
    ],
  )

  if (!Array.isArray(result) || result.length === 0) return null
  const persisted = normalizeCheckpoint(result[0])
  if (!persisted) return null

  if (isRedisConfigured) {
    await redis.set(redisKey(persisted.refundId), persisted)
  }
  return persisted
}

export async function claimRefundIdempotency(idempotencyKey: string, refundId: string): Promise<boolean> {
  if (!isRedisConfigured) return false
  const existing = await redis.get<string>(redisLockKey(idempotencyKey))
  if (existing === refundId) return true
  const claimed = await redis.set(redisLockKey(idempotencyKey), refundId, { nx: true, ex: 60 * 60 * 24 * 30 })
  return claimed === 'OK'
}

export async function releaseRefundIdempotency(idempotencyKey: string, refundId: string): Promise<void> {
  if (!isRedisConfigured) return
  const current = await redis.get<string>(redisLockKey(idempotencyKey))
  if (current === refundId) await redis.del(redisLockKey(idempotencyKey))
}

export async function getRefundCheckpointByIdempotency(idempotencyKey: string): Promise<RefundCheckpoint | null> {
  if (!process.env.DATABASE_URL) return null
  const result = await query('SELECT * FROM refund_checkpoints WHERE idempotency_key = $1', [idempotencyKey])
  if (!Array.isArray(result) || result.length === 0) return null
  return normalizeCheckpoint(result[0])
}

const STAGE_ORDER: RefundCheckpoint['stage'][] = [
  'eligibility_verified', 'intent_created', 'wallet_submission_started',
  'wallet_submission_confirmed', 'payment_checkpoint_updated', 'accounting_recorded', 'audit_recorded',
]

export async function transitionRefundCheckpoint(
  refundId: string,
  fromStage: RefundCheckpoint['stage'],
  toStage: RefundCheckpoint['stage'],
  status: RefundCheckpoint['status'],
  patch: { refundPaymentId?: string; refundTxid?: string; lastErrorCode?: string; lastErrorMessage?: string; nextRetryAt?: string } = {},
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables())) return null
  if (STAGE_ORDER.indexOf(toStage) <= STAGE_ORDER.indexOf(fromStage)) return null
  const result = await query(`
    UPDATE refund_checkpoints SET stage = $2, status = $3, updated_at = NOW(),
      refund_payment_id = COALESCE($4, refund_payment_id), refund_txid = COALESCE($5, refund_txid),
      last_error_code = COALESCE($6, last_error_code), last_error_message = COALESCE($7, last_error_message),
      next_retry_at = COALESCE($8, next_retry_at)
    WHERE refund_id = $1 AND stage = $9 AND status NOT IN ('completed', 'manual_review_required')
    RETURNING *`, [refundId, toStage, status, patch.refundPaymentId ?? null, patch.refundTxid ?? null,
      patch.lastErrorCode ?? null, patch.lastErrorMessage ?? null, patch.nextRetryAt ?? null, fromStage])
  if (!Array.isArray(result) || result.length === 0) return getRefundCheckpoint(refundId)
  return normalizeCheckpoint(result[0])
}

export async function getRefundCheckpoint(refundId: string): Promise<RefundCheckpoint | null> {
  if (isRedisConfigured) {
    const cached = await redis.get<RefundCheckpoint>(redisKey(refundId))
    if (cached) return normalizeCheckpoint(cached)
  }
  if (!process.env.DATABASE_URL) return null
  const result = await query('SELECT * FROM refund_checkpoints WHERE refund_id = $1', [refundId])
  if (!Array.isArray(result) || result.length === 0) return null
  const checkpoint = normalizeCheckpoint(result[0])
  if (checkpoint && isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
  return checkpoint
}

export async function appendRefundAuditEvent(event: RefundAuditEvent): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  const result = await query(
    `INSERT INTO refund_audit_events
      (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT (refund_id, event_type) DO UPDATE SET event_id = refund_audit_events.event_id
     RETURNING event_id`,
    [event.eventId, event.refundId, event.paymentId, event.eventType, event.actorType, event.idempotencyKey, event.createdAt, JSON.stringify(event.details)],
  )
  return Array.isArray(result) && result.length > 0
}

function normalizeCheckpoint(value: unknown): RefundCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const refundId = String(row.refundId ?? row.refund_id ?? '')
  const paymentId = String(row.paymentId ?? row.payment_id ?? '')
  const idempotencyKey = String(row.idempotencyKey ?? row.idempotency_key ?? '')
  const payerUid = String(row.payerUid ?? row.payer_uid ?? '')
  const amount = Number(row.amount)
  if (!refundId || !paymentId || !idempotencyKey || !payerUid || !Number.isFinite(amount) || amount <= 0) return null
  return {
    refundId,
    paymentId,
    idempotencyKey,
    status: String(row.status) as RefundCheckpoint['status'],
    stage: String(row.stage) as RefundCheckpoint['stage'],
    payerUid,
    payerUidVerifiedAt: String(row.payerUidVerifiedAt ?? row.payer_uid_verified_at),
    amount,
    currency: 'π',
    sourcePaymentStatus: String(row.sourcePaymentStatus ?? row.source_payment_status) as RefundCheckpoint['sourcePaymentStatus'],
    sourceSettlementState: String(row.sourceSettlementState ?? row.source_settlement_state) as RefundCheckpoint['sourceSettlementState'],
    createdAt: String(row.createdAt ?? row.created_at),
    updatedAt: String(row.updatedAt ?? row.updated_at),
    refundPaymentId: typeof row.refundPaymentId === 'string' ? row.refundPaymentId : undefined,
    refundTxid: typeof row.refundTxid === 'string' ? row.refundTxid : undefined,
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
    lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : undefined,
    lastErrorMessage: typeof row.lastErrorMessage === 'string' ? row.lastErrorMessage : undefined,
    nextRetryAt: typeof row.nextRetryAt === 'string' ? row.nextRetryAt : undefined,
  }
}
