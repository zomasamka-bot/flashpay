import { redis, isRedisConfigured } from './redis'
import { query } from './db'
import type { Payment, RefundAuditEvent, RefundCheckpoint } from './types'

const redisKey = (refundId: string) => `flashpay:refund:checkpoint:${refundId}`
const redisLockKey = (idempotencyKey: string) => `flashpay:refund:idempotency:${idempotencyKey}`
const paymentOperationLockKey = (paymentId: string) => `flashpay:payment:operation:${paymentId}`

export async function acquirePaymentOperationLock(paymentId: string, owner: string): Promise<boolean> {
  if (!isRedisConfigured) return false
  const result = await redis.set(paymentOperationLockKey(paymentId), owner, { nx: true, ex: 60 * 60 * 24 * 30 })
  return result === 'OK'
}

export async function ensurePaymentOperationLock(paymentId: string, refundId: string): Promise<boolean> {
  if (!isRedisConfigured) return false
  const result = await redis.eval(
    'local v=redis.call("get",KEYS[1]); if not v then local ok=redis.call("set",KEYS[1],ARGV[1],"NX","EX",ARGV[2]); return ok=="OK" and 1 or 0 end; if v==ARGV[1] then redis.call("expire",KEYS[1],ARGV[2]); return 1 end; return 0',
    [paymentOperationLockKey(paymentId)], [refundId, String(60 * 60 * 24 * 30)],
  )
  return Number(result) === 1
}

export async function releasePaymentOperationLock(paymentId: string, owner: string): Promise<void> {
  if (!isRedisConfigured) return
  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    [paymentOperationLockKey(paymentId)],
    [owner],
  )
}

export type RefundSchemaDiagnostics = {
  refund_checkpoints: boolean
  refund_audit_events: boolean
  idx_refund_checkpoints_status_retry: boolean
  idx_refund_checkpoints_payment: boolean
  idx_refund_audit_payment_created: boolean
  idx_refund_audit_refund_created: boolean
}

export async function getRefundSchemaDiagnostics(): Promise<RefundSchemaDiagnostics> {
  const names = [
    'refund_checkpoints', 'refund_audit_events', 'idx_refund_checkpoints_status_retry',
    'idx_refund_checkpoints_payment', 'idx_refund_audit_payment_created', 'idx_refund_audit_refund_created',
  ] as const
  let result: unknown[] = []
  try {
    result = await query(`
      SELECT name, EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = name AND c.relkind IN ('r','i') AND n.nspname = current_schema()
      ) AS present
      FROM unnest($1::text[]) AS names(name)
    `, [names])
  } catch {
    result = []
  }
  const diagnostics = Object.fromEntries(names.map((name) => [name, false])) as RefundSchemaDiagnostics
  if (Array.isArray(result)) {
    for (const row of result) {
      if (typeof row?.name === 'string' && row.name in diagnostics) diagnostics[row.name as keyof RefundSchemaDiagnostics] = row.present === true
    }
  }
  return diagnostics
}

export async function verifyRefundTables(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    const result = await query(`
      SELECT to_regclass('public.refund_checkpoints') AS checkpoints,
             to_regclass('public.refund_audit_events') AS audits,
             to_regclass('public.idx_refund_checkpoints_status_retry') AS status_retry,
             to_regclass('public.idx_refund_checkpoints_payment') AS payment_index,
             to_regclass('public.idx_refund_audit_payment_created') AS audit_payment,
             to_regclass('public.idx_refund_audit_refund_created') AS audit_refund
    `)
    const row = Array.isArray(result) && result.length > 0 ? result[0] as Record<string, unknown> : null
    return Boolean(row?.checkpoints && row?.audits && row?.status_retry && row?.payment_index && row?.audit_payment && row?.audit_refund)
  } catch {
    return false
  }
}

/**
 * Phase 2 persistence boundary. Database is authoritative; Redis is a fast
 * recovery mirror and idempotency claim. No wallet operation belongs here.
 */
export async function createRefundCheckpointWithAudit(checkpoint: RefundCheckpoint, event: RefundAuditEvent): Promise<RefundCheckpoint | null> {
  if (!process.env.DATABASE_URL) return null
  const result = await query(`
    WITH inserted AS (
      INSERT INTO refund_checkpoints
        (refund_id, payment_id, idempotency_key, status, stage, payer_uid,
         payer_uid_verified_at, amount, currency, source_payment_status,
         source_settlement_state, created_at, updated_at, attempt_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (payment_id) DO NOTHING
      RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events
        (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $15, refund_id, payment_id, $16, $17, idempotency_key, $18, $19::jsonb FROM inserted
      RETURNING refund_id
    ) SELECT inserted.* FROM inserted JOIN audited USING (refund_id)`, [
      checkpoint.refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.status, checkpoint.stage,
      checkpoint.payerUid, checkpoint.payerUidVerifiedAt, checkpoint.amount, checkpoint.currency,
      checkpoint.sourcePaymentStatus, checkpoint.sourceSettlementState, checkpoint.createdAt, checkpoint.updatedAt,
      checkpoint.attemptCount, event.eventId, event.eventType, event.actorType, event.createdAt, JSON.stringify(event.details),
    ])
  if (!Array.isArray(result) || result.length === 0) return null
  const persisted = normalizeCheckpoint(result[0])
  if (persisted && isRedisConfigured) await redis.set(redisKey(persisted.refundId), persisted)
  return persisted
}

export async function transitionRefundCheckpointWithAudit(
  refundId: string, fromStage: RefundCheckpoint['stage'], toStage: RefundCheckpoint['stage'], status: RefundCheckpoint['status'],
  event: RefundAuditEvent, patch: { refundPaymentId?: string; refundTxid?: string; lastErrorCode?: string; lastErrorMessage?: string; nextRetryAt?: string } = {},
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables())) return null
  const fromIndex = STAGE_ORDER.indexOf(fromStage), toIndex = STAGE_ORDER.indexOf(toStage)
  if (fromIndex < 0 || toIndex !== fromIndex + 1) return null
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET stage=$2, status=$3, updated_at=NOW(),
        refund_payment_id=COALESCE($4, refund_payment_id), refund_txid=COALESCE($5, refund_txid),
        last_error_code=COALESCE($6, last_error_code), last_error_message=COALESCE($7, last_error_message),
        next_retry_at=COALESCE($8, next_retry_at)
      WHERE refund_id=$1 AND stage=$9 AND status NOT IN ('failed','completed','manual_review_required') RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events
        (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $10, refund_id, payment_id, $11, $12, idempotency_key, $13, $14::jsonb FROM transitioned
      RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`, [
      refundId, toStage, status, patch.refundPaymentId ?? null, patch.refundTxid ?? null,
      patch.lastErrorCode ?? null, patch.lastErrorMessage ?? null, patch.nextRetryAt ?? null, fromStage,
      event.eventId, event.eventType, event.actorType, event.createdAt, JSON.stringify(event.details),
    ])
  if (!Array.isArray(result) || result.length === 0) return null
  const transitioned = normalizeCheckpoint(result[0])
  if (transitioned && isRedisConfigured) await redis.set(redisKey(refundId), transitioned)
  return transitioned
}

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
  await redis.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    [redisLockKey(idempotencyKey)],
    [refundId],
  )
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

export async function beginRefundSubmissionAttempt(refundId: string, event: RefundAuditEvent): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables())) return null
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET stage='wallet_submission_started', status='pending', attempt_count=attempt_count+1, updated_at=NOW()
      WHERE refund_id=$1 AND stage='intent_created' AND status='pending' RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $2, refund_id, payment_id, 'refund_submission_started', $3, idempotency_key, $4, $5::jsonb FROM transitioned
      RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, event.eventId, event.actorType, event.createdAt, JSON.stringify(event.details)],
  )
  if (!Array.isArray(result) || result.length === 0) return null
  const checkpoint = normalizeCheckpoint(result[0])
  if (checkpoint && isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
  return checkpoint
}

export async function transitionRefundCheckpoint(
  refundId: string,
  fromStage: RefundCheckpoint['stage'],
  toStage: RefundCheckpoint['stage'],
  status: RefundCheckpoint['status'],
  patch: { refundPaymentId?: string; refundTxid?: string; lastErrorCode?: string; lastErrorMessage?: string; nextRetryAt?: string } = {},
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables())) return null
  const fromIndex = STAGE_ORDER.indexOf(fromStage)
  const toIndex = STAGE_ORDER.indexOf(toStage)
  if (fromIndex < 0 || toIndex !== fromIndex + 1) return null
  const result = await query(`
    UPDATE refund_checkpoints SET stage = $2, status = $3, updated_at = NOW(),
      refund_payment_id = COALESCE($4, refund_payment_id), refund_txid = COALESCE($5, refund_txid),
      last_error_code = COALESCE($6, last_error_code), last_error_message = COALESCE($7, last_error_message),
      next_retry_at = COALESCE($8, next_retry_at)
    WHERE refund_id = $1 AND stage = $9 AND status NOT IN ('failed', 'completed', 'manual_review_required')
    RETURNING *`, [refundId, toStage, status, patch.refundPaymentId ?? null, patch.refundTxid ?? null,
      patch.lastErrorCode ?? null, patch.lastErrorMessage ?? null, patch.nextRetryAt ?? null, fromStage])
  if (!Array.isArray(result) || result.length === 0) return null
  const transitioned = normalizeCheckpoint(result[0])
  if (transitioned && isRedisConfigured) await redis.set(redisKey(refundId), transitioned)
  return transitioned
}

export function refundPreflight(
  checkpoint: RefundCheckpoint,
  payment: Payment,
  input: { paymentId: string; payerUid: string; amount: number },
): boolean {
  return checkpoint.status === 'pending' && checkpoint.stage === 'intent_created' &&
    checkpoint.sourcePaymentStatus === 'settlement_failed' && checkpoint.sourceSettlementState === 'refund_pending' &&
    checkpoint.paymentId === input.paymentId && checkpoint.payerUid === input.payerUid && checkpoint.amount === input.amount &&
    payment.id === input.paymentId && payment.status === 'settlement_failed' && payment.settlementFailureState === 'refund_pending' &&
    payment.refundStatus === 'pending' && typeof payment.payerUidCapturedAt === 'string' && payment.payerUidCapturedAt.trim().length > 0 &&
    payment.payerUidSource === 'verified_u2a' && payment.payerRefundEligible === true && payment.payerUid === input.payerUid &&
    payment.customerAmount === input.amount && !payment.a2uPaymentId && !payment.a2uTxid &&
    payment.horizonSuccessFlag !== true && !payment.refundPaymentId && !payment.refundTxid
}

export async function getRefundCheckpointAuthoritative(refundId: string): Promise<RefundCheckpoint | null> {
  if (!process.env.DATABASE_URL) return null
  const result = await query('SELECT * FROM refund_checkpoints WHERE refund_id = $1', [refundId])
  if (!Array.isArray(result) || result.length === 0) return null
  const checkpoint = normalizeCheckpoint(result[0])
  if (checkpoint && isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
  return checkpoint
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
     ON CONFLICT (event_id) DO NOTHING
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
    refundPaymentId: typeof (row.refundPaymentId ?? row.refund_payment_id) === 'string' ? (row.refundPaymentId ?? row.refund_payment_id) as string : undefined,
    refundTxid: typeof (row.refundTxid ?? row.refund_txid) === 'string' ? (row.refundTxid ?? row.refund_txid) as string : undefined,
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
    lastErrorCode: typeof (row.lastErrorCode ?? row.last_error_code) === 'string' ? (row.lastErrorCode ?? row.last_error_code) as string : undefined,
    lastErrorMessage: typeof (row.lastErrorMessage ?? row.last_error_message) === 'string' ? (row.lastErrorMessage ?? row.last_error_message) as string : undefined,
    nextRetryAt: typeof (row.nextRetryAt ?? row.next_retry_at) === 'string' ? (row.nextRetryAt ?? row.next_retry_at) as string : undefined,
  }
}
