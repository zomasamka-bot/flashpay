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

export type RefundCheckpointReadOnly =
  | { state: 'present'; checkpoint: RefundCheckpoint }
  | { state: 'absent' }
  | { state: 'uncertain' }

const STAGE_ORDER: RefundCheckpoint['stage'][] = ['eligibility_verified', 'intent_created', 'wallet_submission_started', 'wallet_submission_confirmed', 'payment_checkpoint_updated', 'accounting_recorded', 'audit_recorded']

export type AutomaticRefundCheckpointResult =
  | { state: 'ok'; checkpoints: RefundCheckpoint[] }
  | { state: 'uncertain' }

export async function listAutomaticRefundCheckpoints(limit: number): Promise<AutomaticRefundCheckpointResult> {
  if (!Number.isInteger(limit) || limit <= 0) return { state: 'uncertain' }
  try {
    const rows = await query(`
      SELECT * FROM refund_checkpoints
      WHERE (status='pending' OR (stage='audit_recorded' AND status='completed' AND NOT (
        (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=refund_checkpoints.refund_id AND a.event_type='refund_projection_finalized')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=refund_checkpoints.refund_id AND a.event_type='refund_projection_finalized' AND refund_checkpoints.refund_payment_id IS NOT NULL AND refund_checkpoints.refund_txid IS NOT NULL AND a.event_id='refund:'||refund_checkpoints.refund_id||':projection_finalized' AND a.payment_id=refund_checkpoints.payment_id AND a.idempotency_key=refund_checkpoints.idempotency_key AND a.actor_type='system' AND a.details=jsonb_build_object('refundPaymentId',refund_checkpoints.refund_payment_id,'refundTxid',refund_checkpoints.refund_txid))=1
      )))
        AND (next_retry_at IS NULL OR next_retry_at<=NOW())
      ORDER BY updated_at ASC, refund_id ASC
      LIMIT $1`, [Math.min(limit, 20)])
    if (!Array.isArray(rows)) return { state: 'uncertain' }
    const checkpoints: RefundCheckpoint[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return { state: 'uncertain' }
      const checkpoint = normalizeCheckpoint(row)
      if (!checkpoint) return { state: 'uncertain' }
      const validLifecycle = (checkpoint.status === 'pending' && STAGE_ORDER.includes(checkpoint.stage)) || (checkpoint.stage === 'audit_recorded' && checkpoint.status === 'completed')
      if (!validLifecycle || !Number.isSafeInteger(checkpoint.attemptCount) || checkpoint.attemptCount < 0) return { state: 'uncertain' }
      checkpoints.push(checkpoint)
    }
    return { state: 'ok', checkpoints }
  } catch { return { state: 'uncertain' } }
}

export async function getRefundCheckpointReadOnly(refundId: string): Promise<RefundCheckpointReadOnly> {
  if (typeof refundId !== 'string' || refundId.trim().length === 0) return { state: 'uncertain' }
  try {
    const rows = await query('SELECT * FROM refund_checkpoints WHERE refund_id=$1 LIMIT 2', [refundId])
    if (!Array.isArray(rows)) return { state: 'uncertain' }
    if (rows.length === 0) return { state: 'absent' }
    if (rows.length !== 1 || typeof rows[0] !== 'object' || rows[0] === null || Array.isArray(rows[0])) return { state: 'uncertain' }
    const checkpoint = normalizeCheckpoint(rows[0])
    return checkpoint ? { state: 'present', checkpoint } : { state: 'uncertain' }
  } catch { return { state: 'uncertain' } }
}

export async function deferAutomaticRefund(
  refundId: string,
  expectedStage: RefundCheckpoint['stage'],
  expectedStatus: RefundCheckpoint['status'],
  errorCode: string,
  errorMessage: string,
  nextRetryAt: string,
): Promise<RefundCheckpoint | null> {
  if (typeof refundId !== 'string' || refundId.length === 0 || typeof expectedStage !== 'string' || expectedStage.length === 0 || typeof expectedStatus !== 'string' || expectedStatus.length === 0 || typeof errorCode !== 'string' || errorCode.length === 0 || typeof errorMessage !== 'string' || errorMessage.length === 0 || typeof nextRetryAt !== 'string' || nextRetryAt.length === 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(nextRetryAt)) return null
  const retryAt = new Date(nextRetryAt)
  if (Number.isNaN(retryAt.getTime()) || retryAt.getTime() <= Date.now()) return null
  try {
    console.warn('[refunds/auto-deferral] Write:', { refundId, status: expectedStatus, stage: expectedStage, errorCode, reason: errorMessage, executorStep: expectedStage })
    const rows = await query(`
      UPDATE refund_checkpoints
      SET last_error_code=$3, last_error_message=$4, next_retry_at=$5::timestamptz, updated_at=NOW()
      WHERE refund_id=$1 AND stage=$2 AND status=$6
        AND (next_retry_at IS NULL OR next_retry_at<=NOW())
      RETURNING *`, [refundId, expectedStage, errorCode, errorMessage, nextRetryAt, expectedStatus])
    if (!Array.isArray(rows) || rows.length !== 1) return null
    const checkpoint = normalizeCheckpoint(rows[0])
    return checkpoint && checkpoint.refundId === refundId && checkpoint.stage === expectedStage && checkpoint.status === expectedStatus ? checkpoint : null
  } catch { return null }
}

export async function clearAutomaticRefundDeferral(refundId: string): Promise<RefundCheckpoint | null> {
  if (typeof refundId !== 'string' || refundId.length === 0) return null
  try {
    const rows = await query(`
      UPDATE refund_checkpoints
      SET last_error_code=NULL, last_error_message=NULL, next_retry_at=NULL, updated_at=NOW()
      WHERE refund_id=$1 AND (next_retry_at IS NULL OR next_retry_at<=NOW())
      RETURNING *`, [refundId])
    if (!Array.isArray(rows) || rows.length !== 1) return null
    const checkpoint = normalizeCheckpoint(rows[0])
    return checkpoint && checkpoint.refundId === refundId ? checkpoint : null
  } catch { return null }
}

export async function getRefundSchemaDiagnostics(): Promise<RefundSchemaDiagnostics> {
  const names = [
    'refund_checkpoints', 'refund_audit_events', 'idx_refund_checkpoints_status_retry',
    'idx_refund_checkpoints_payment', 'idx_refund_audit_payment_created', 'idx_refund_audit_refund_created',
  ] as const
  let rawResult: unknown
  try {
    rawResult = await query(`
      SELECT name, EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = name
          AND c.relkind = CASE
            WHEN name IN ('refund_checkpoints', 'refund_audit_events') THEN 'r'
            ELSE 'i'
          END
      ) AS present
      FROM unnest($1::text[]) AS names(name)
    `, [names])
  } catch {
    rawResult = null
  }
  const diagnostics = Object.fromEntries(names.map((name) => [name, false])) as RefundSchemaDiagnostics
  if (Array.isArray(rawResult)) {
    for (const row of rawResult) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
      const record: Record<string, unknown> = row
      if (typeof record.name !== 'string' || !(record.name in diagnostics)) continue
      diagnostics[record.name as keyof RefundSchemaDiagnostics] = record.present === true
    }
  }
  return diagnostics
}

export async function verifyRefundAccountingSchema(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    const result = await query(`
      WITH target AS (
        SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname='refund_accounting_records' AND c.relkind='r'
      ), constraints AS (
        SELECT con.*, pg_get_expr(con.conbin, con.conrelid) AS expression
        FROM pg_constraint con JOIN target t ON t.oid=con.conrelid
      ), key_columns AS (
        SELECT con.oid, con.contype, array_agg(att.attname::text ORDER BY k.ordinality) AS names
        FROM constraints con JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum, ordinality) ON true
        JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=k.attnum
        GROUP BY con.oid, con.contype
      ), defaults AS (
        SELECT a.attname, pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_attribute a JOIN target t ON t.oid=a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attnum>0 AND NOT a.attisdropped
      ), checks AS (
        SELECT regexp_replace(regexp_replace(lower(expression), '\\s+', '', 'g'), '[()]|::[a-z0-9_\\." ]+', '', 'g') AS normalized
        FROM constraints WHERE contype='c'
      )
      SELECT
        EXISTS (SELECT 1 FROM target) AS table_exists,
        (SELECT count(*)=1 FROM constraints WHERE contype='p' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=(SELECT oid FROM target) AND attname='refund_id')::smallint]) AS exact_pk,
        (SELECT count(*) FROM constraints con
          WHERE con.contype='f' AND con.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=con.conrelid AND attname='refund_id')::smallint]
          AND con.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=con.confrelid AND attname='refund_id')::smallint]
          AND con.confrelid='public.refund_checkpoints'::regclass AND con.confdeltype='r')=1 AS exact_fk,
        (SELECT count(*) FROM key_columns WHERE contype='u' AND names=ARRAY['payment_id'])=1 AND
        (SELECT count(*) FROM key_columns WHERE contype='u' AND names=ARRAY['refund_payment_id'])=1 AND
        (SELECT count(*) FROM key_columns WHERE contype='u' AND names=ARRAY['refund_txid'])=1 AS exact_uniques,
        (SELECT count(*) FROM constraints WHERE contype='p')=1 AND (SELECT count(*) FROM constraints WHERE contype='f')=1 AND
        (SELECT count(*) FROM constraints WHERE contype='u')=3 AND (SELECT count(*) FROM constraints WHERE contype='c')=2 AS constraint_set,
        (SELECT count(*)=5 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_accounting_records' AND column_name IN ('refund_id','payment_id','refund_payment_id','refund_txid','payer_uid') AND data_type='text' AND is_nullable='NO') AS text_columns,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_accounting_records' AND column_name='amount' AND data_type='numeric' AND is_nullable='NO' AND numeric_precision=18 AND numeric_scale=8) AS amount_column,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_accounting_records' AND column_name='horizon_fee_stroops' AND data_type='bigint' AND is_nullable='NO') AS fee_column,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_accounting_records' AND column_name='currency' AND data_type='text' AND is_nullable='NO') AS currency_column,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_accounting_records' AND column_name='created_at' AND data_type='timestamp without time zone' AND is_nullable='NO') AS created_column,
        (SELECT regexp_replace(expression, '::text$', '') = '''π''' FROM defaults WHERE attname='currency') AS currency_default,
        (SELECT regexp_replace(lower(expression),'\\s+','','g') LIKE 'now()%' FROM defaults WHERE attname='created_at') AS created_default,
        (SELECT count(*) FROM checks WHERE normalized='amount>0')=1 AS amount_check,
        (SELECT count(*) FROM checks WHERE normalized='horizon_fee_stroops>=0')=1 AS fee_check
    `)
    const row = Array.isArray(result) && result.length===1 ? result[0] as Record<string, unknown> : null
    console.warn("[refunds/accounting-schema] Checks:", row)
    return Boolean(row?.table_exists && row.exact_pk && row.exact_fk && row.exact_uniques && row.constraint_set && row.text_columns && row.amount_column && row.fee_column && row.currency_column && row.created_column && row.currency_default && row.created_default && row.amount_check && row.fee_check)
  } catch { return false }
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
      checkpoint.attemptCount, event.eventId, event.eventType, event.actorType, event.createdAt, event.details,
    ])
  if (!Array.isArray(result) || result.length === 0) return null
  const persisted = normalizeCheckpoint(result[0])
  if (persisted && isRedisConfigured) await redis.set(redisKey(persisted.refundId), persisted)
  return persisted
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

export async function beginRefundSubmissionAttempt(refundId: string, event: RefundAuditEvent): Promise<{ checkpoint: RefundCheckpoint; startedNow: boolean } | null> {
  if (!(await verifyRefundTables()) || event.refundId !== refundId) return null
  const existing = await query(`
    SELECT c.*, a.event_id AS submission_audit_id
    FROM refund_checkpoints c
    LEFT JOIN refund_audit_events a
      ON a.refund_id = c.refund_id AND a.payment_id = c.payment_id
     AND a.idempotency_key = c.idempotency_key AND a.event_type = 'refund_submission_started'
    WHERE c.refund_id = $1 AND c.payment_id = $2 AND c.idempotency_key = $3
    ORDER BY a.created_at DESC LIMIT 1`, [refundId, event.paymentId, event.idempotencyKey])
  if (Array.isArray(existing) && existing.length > 0) {
    const row = existing[0]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
    const record = row as Record<string, unknown>
    const current = normalizeCheckpoint(record)
    if (current && current.stage === 'wallet_submission_started' && current.status === 'pending' &&
      typeof record.submission_audit_id === 'string') {
      if (isRedisConfigured) await redis.set(redisKey(refundId), current)
      return { checkpoint: current, startedNow: false }
    }
  }
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET stage='wallet_submission_started', status='pending', attempt_count=attempt_count+1, updated_at=NOW()
      WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND stage='intent_created' AND status='pending' RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $4, refund_id, payment_id, 'refund_submission_started', $5, idempotency_key, $6, $7::jsonb FROM transitioned
      RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, event.paymentId, event.idempotencyKey, event.eventId, event.actorType, event.createdAt, event.details],
  )
  if (!Array.isArray(result) || result.length === 0) return null
  const checkpoint = normalizeCheckpoint(result[0])
  if (!checkpoint) return null
  if (isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
  return { checkpoint, startedNow: true }
}

export async function beginRefundBlockchainSubmissionClaim(
  refundId: string,
  paymentId: string,
  idempotencyKey: string,
  refundPaymentId: string,
  actorType: RefundAuditEvent['actorType'] = 'system',
): Promise<{ checkpoint: RefundCheckpoint; startedNow: boolean } | null> {
  if (!(await verifyRefundTables()) || !refundId || !paymentId || !idempotencyKey || !refundPaymentId) return null
  const eventId = `refund:${refundId}:blockchain_submission_started`
  const createdAt = new Date().toISOString()
  const details = { refundPaymentId, phase: 'blockchain_submission' }
  const result = await query(`
    WITH audited AS (
      INSERT INTO refund_audit_events
        (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $1, refund_id, payment_id, 'refund_blockchain_submission_started', $2, idempotency_key, $3, $4::jsonb
      FROM refund_checkpoints
      WHERE refund_id=$5 AND payment_id=$6 AND idempotency_key=$7
        AND refund_payment_id=$8 AND stage='wallet_submission_started' AND status='pending'
      ON CONFLICT (event_id) DO NOTHING
      RETURNING refund_id
    ) SELECT * FROM audited`,
    [eventId, actorType, createdAt, details, refundId, paymentId, idempotencyKey, refundPaymentId],
  )
  if (Array.isArray(result) && result.length > 0) {
    const checkpointResult = await query(`SELECT * FROM refund_checkpoints WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND refund_payment_id=$4 AND stage='wallet_submission_started' AND status='pending' LIMIT 1`, [refundId, paymentId, idempotencyKey, refundPaymentId])
    if (!Array.isArray(checkpointResult) || checkpointResult.length !== 1) return null
    const row = checkpointResult[0]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
    const checkpoint = normalizeCheckpoint(row as Record<string, unknown>)
    return checkpoint ? { checkpoint, startedNow: true } : null
  }
  const replay = await query(`
    SELECT c.*, a.event_id AS blockchain_audit_id, a.event_type AS blockchain_audit_event_type,
      a.refund_id AS audit_refund_id, a.payment_id AS audit_payment_id,
      a.idempotency_key AS audit_idempotency_key, a.actor_type AS audit_actor_type,
      a.details AS blockchain_audit_details
    FROM refund_checkpoints c JOIN refund_audit_events a
      ON a.event_id=$1 AND a.event_type='refund_blockchain_submission_started'
    WHERE c.refund_id=$2 AND c.payment_id=$3 AND c.idempotency_key=$4
      AND c.refund_payment_id=$5 AND c.stage='wallet_submission_started' AND c.status='pending'
    LIMIT 1`, [eventId, refundId, paymentId, idempotencyKey, refundPaymentId])
  if (!Array.isArray(replay) || replay.length !== 1) return null
  const replayRow = replay[0]
  if (typeof replayRow !== 'object' || replayRow === null || Array.isArray(replayRow)) return null
  const record = replayRow as Record<string, unknown>
  if (record.blockchain_audit_id !== eventId || record.blockchain_audit_event_type !== 'refund_blockchain_submission_started' ||
    record.audit_refund_id !== refundId || record.audit_payment_id !== paymentId ||
    record.audit_idempotency_key !== idempotencyKey || record.audit_actor_type !== actorType) return null
  if (typeof record.blockchain_audit_details !== 'object' || record.blockchain_audit_details === null || Array.isArray(record.blockchain_audit_details)) return null
  const auditDetails = record.blockchain_audit_details as Record<string, unknown>
  if (Object.keys(auditDetails).length !== 2 || auditDetails.refundPaymentId !== refundPaymentId || auditDetails.phase !== 'blockchain_submission') return null
  const checkpoint = normalizeCheckpoint(record)
  return checkpoint ? { checkpoint, startedNow: false } : null
}

export async function persistRefundPaymentIdWithAudit(refundId: string, paymentId: string, idempotencyKey: string, refundPaymentId: string, event: RefundAuditEvent): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || !refundPaymentId) return null
  const currentResult = await query(`SELECT * FROM refund_checkpoints WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND stage='wallet_submission_started' AND status='pending' LIMIT 1`, [refundId, paymentId, idempotencyKey])
  if (!Array.isArray(currentResult) || currentResult.length === 0) return null
  const currentRow = currentResult[0]
  if (typeof currentRow !== 'object' || currentRow === null || Array.isArray(currentRow)) return null
  const current = normalizeCheckpoint(currentRow as Record<string, unknown>)
  if (!current) return null
  if (current.refundPaymentId === refundPaymentId) return current
  if (current.refundPaymentId) return null
  const result = await query(`
    WITH updated AS (
      UPDATE refund_checkpoints SET refund_payment_id=$4, updated_at=NOW()
      WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND stage='wallet_submission_started' AND status='pending'
        AND refund_payment_id IS NULL RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $5, refund_id, payment_id, $6, $7, idempotency_key, $8, $9::jsonb FROM updated
      RETURNING refund_id
    ) SELECT updated.* FROM updated JOIN audited USING (refund_id)`,
    [refundId, paymentId, idempotencyKey, refundPaymentId, event.eventId, event.eventType, event.actorType, event.createdAt, event.details],
  )
  if (Array.isArray(result) && result.length > 0) {
    const checkpoint = normalizeCheckpoint(result[0])
    if (checkpoint && isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
    return checkpoint
  }
  const replayResult = await query(`SELECT * FROM refund_checkpoints WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND stage='wallet_submission_started' AND status='pending' LIMIT 1`, [refundId, paymentId, idempotencyKey])
  if (!Array.isArray(replayResult) || replayResult.length === 0) return null
  const replayRow = replayResult[0]
  if (typeof replayRow !== 'object' || replayRow === null || Array.isArray(replayRow)) return null
  const replay = normalizeCheckpoint(replayRow as Record<string, unknown>)
  if (!replay || replay.refundPaymentId !== refundPaymentId) return null
  return replay
}

export async function persistRefundBlockchainTxWithAudit(
  refundId: string,
  paymentId: string,
  idempotencyKey: string,
  refundPaymentId: string,
  refundTxid: string,
  event: RefundAuditEvent,
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || !event.eventId || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || event.eventType !== 'refund_submission_confirmed' || !refundTxid || typeof event.details !== 'object' || event.details === null || Array.isArray(event.details) || (event.details as Record<string, unknown>).refundPaymentId !== refundPaymentId || (event.details as Record<string, unknown>).refundTxid !== refundTxid) return null
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET refund_txid=$5, stage='wallet_submission_confirmed', updated_at=NOW()
      WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND refund_payment_id=$4
        AND stage='wallet_submission_started' AND status='pending' AND refund_txid IS NULL RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $6, refund_id, payment_id, $7, $8, idempotency_key, $9, $10::jsonb FROM transitioned RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, event.eventId, event.eventType, event.actorType, event.createdAt, event.details],
  )
  if (Array.isArray(result) && result.length > 0) {
    const checkpoint = normalizeCheckpoint(result[0])
    if (checkpoint && isRedisConfigured) await redis.set(redisKey(refundId), checkpoint)
    return checkpoint
  }
  const replayResult = await query(`
    SELECT c.*, a.event_id AS audit_event_id, a.event_type AS audit_event_type,
      a.refund_id AS audit_refund_id, a.payment_id AS audit_payment_id,
      a.idempotency_key AS audit_idempotency_key, a.actor_type AS audit_actor_type,
      a.details AS audit_details
    FROM refund_checkpoints c
    JOIN refund_audit_events a
      ON a.refund_id=c.refund_id AND a.payment_id=c.payment_id
      AND a.idempotency_key=c.idempotency_key
      AND a.event_type='refund_submission_confirmed'
    WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3
      AND c.refund_payment_id=$4 AND c.stage='wallet_submission_confirmed'
      AND c.status='pending' AND c.refund_txid=$5
    LIMIT 2`, [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid])
  if (!Array.isArray(replayResult) || replayResult.length !== 1) return null
  const row = replayResult[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const record = row as Record<string, unknown>
  if (typeof record.audit_event_id !== 'string' || record.audit_event_id.length === 0 || record.audit_event_type !== 'refund_submission_confirmed' ||
    record.audit_refund_id !== refundId || record.audit_payment_id !== paymentId ||
    record.audit_idempotency_key !== idempotencyKey || record.audit_actor_type !== event.actorType) return null
  if (typeof record.audit_details !== 'object' || record.audit_details === null || Array.isArray(record.audit_details)) return null
  const details = record.audit_details as Record<string, unknown>
  if (details.refundPaymentId !== refundPaymentId || details.refundTxid !== refundTxid) return null
  const checkpoint = normalizeCheckpoint(record)
  return checkpoint ?? null
}

export async function advanceRefundPaymentCheckpointWithAudit(refundId: string, paymentId: string, idempotencyKey: string, refundPaymentId: string, refundTxid: string, event: RefundAuditEvent): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || !event.eventId || event.eventType !== 'refund_payment_checkpoint_updated' || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || !refundPaymentId || !refundTxid || typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) return null
  const eventDetails = event.details as Record<string, unknown>
  if (Object.keys(eventDetails).length !== 2 || eventDetails.refundPaymentId !== refundPaymentId || eventDetails.refundTxid !== refundTxid) return null
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET stage='payment_checkpoint_updated', updated_at=NOW()
      WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND refund_payment_id=$4 AND refund_txid=$5
        AND stage='wallet_submission_confirmed' AND status='pending' RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $6, refund_id, payment_id, $7, $8, idempotency_key, $9, $10::jsonb FROM transitioned RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, event.eventId, event.eventType, event.actorType, event.createdAt, event.details],
  )
  if (Array.isArray(result) && result.length > 0) return normalizeCheckpoint(result[0])
  const replay = await query(`
    SELECT c.*, a.event_id AS audit_event_id, a.event_type AS audit_event_type,
      a.refund_id AS audit_refund_id, a.payment_id AS audit_payment_id,
      a.idempotency_key AS audit_idempotency_key, a.actor_type AS audit_actor_type,
      a.details AS audit_details
    FROM refund_checkpoints c
    JOIN refund_audit_events a
      ON a.refund_id=c.refund_id AND a.payment_id=c.payment_id
      AND a.idempotency_key=c.idempotency_key
      AND a.event_type='refund_payment_checkpoint_updated'
    WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3
      AND c.refund_payment_id=$4 AND c.refund_txid=$5
      AND c.stage='payment_checkpoint_updated' AND c.status='pending'
    LIMIT 2`, [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid])
  if (!Array.isArray(replay) || replay.length !== 1) return null
  const record = replay[0]
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null
  const replayRecord = record as Record<string, unknown>
  if (typeof replayRecord.audit_event_id !== 'string' || replayRecord.audit_event_id.length === 0 ||
    replayRecord.audit_event_type !== 'refund_payment_checkpoint_updated' ||
    replayRecord.audit_refund_id !== refundId || replayRecord.audit_payment_id !== paymentId ||
    replayRecord.audit_idempotency_key !== idempotencyKey || replayRecord.audit_actor_type !== event.actorType) return null
  if (typeof replayRecord.audit_details !== 'object' || replayRecord.audit_details === null || Array.isArray(replayRecord.audit_details)) return null
  const replayDetails = replayRecord.audit_details as Record<string, unknown>
  if (Object.keys(replayDetails).length !== 2 || replayDetails.refundPaymentId !== refundPaymentId || replayDetails.refundTxid !== refundTxid) return null
  const checkpoint = normalizeCheckpoint(replayRecord)
  return checkpoint ?? null
}

export async function advanceRefundAccountingWithAudit(
  refundId: string,
  paymentId: string,
  idempotencyKey: string,
  refundPaymentId: string,
  refundTxid: string,
  payerUid: string,
  amount: number,
  horizonFeeStroops: number,
  event: RefundAuditEvent,
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || !(await verifyRefundAccountingSchema()) || !event.eventId || event.eventType !== 'refund_accounting_recorded' || event.actorType !== 'system' || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || typeof horizonFeeStroops !== 'number' || !Number.isSafeInteger(horizonFeeStroops) || horizonFeeStroops < 0 || typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) return null
  const details = event.details as Record<string, unknown>
  if (Object.keys(details).length !== 3 || details.refundPaymentId !== refundPaymentId || details.refundTxid !== refundTxid || details.horizonFeeStroops !== horizonFeeStroops) return null
  const result = await query(`
    WITH matching AS (
      SELECT c.refund_id FROM refund_checkpoints c
      JOIN refund_accounting_records a ON a.refund_id=c.refund_id
      WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$13 AND c.refund_payment_id=$3 AND c.refund_txid=$4
        AND c.payer_uid=$5 AND c.amount=$6::numeric AND c.stage='payment_checkpoint_updated' AND c.status='pending'
        AND a.payment_id=c.payment_id AND a.refund_payment_id=c.refund_payment_id AND a.refund_txid=c.refund_txid
        AND a.payer_uid=c.payer_uid AND a.amount=c.amount AND a.horizon_fee_stroops=$7::bigint AND a.currency='π'
    ), transitioned AS (
      UPDATE refund_checkpoints SET stage='accounting_recorded', updated_at=NOW()
      WHERE refund_id IN (SELECT refund_id FROM matching) RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $8, refund_id, payment_id, $9, $10, idempotency_key, $11, $12::jsonb FROM transitioned RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, paymentId, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, event.eventId, event.eventType, event.actorType, event.createdAt, event.details, idempotencyKey],
  )
  if (Array.isArray(result) && result.length > 1) return null
  if (Array.isArray(result) && result.length === 1) return normalizeCheckpoint(result[0])
  const replay = await query(`
    SELECT c.*, a.event_id AS audit_event_id, a.event_type AS audit_event_type, a.actor_type AS audit_actor_type, a.details AS audit_details
    FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
    JOIN refund_audit_events a ON a.refund_id=c.refund_id AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_type='refund_accounting_recorded'
    WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$8 AND c.refund_payment_id=$3 AND c.refund_txid=$4 AND c.payer_uid=$5 AND c.amount=$6::numeric
      AND c.stage='accounting_recorded' AND c.status='pending' AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$7::bigint AND r.currency='π' LIMIT 2`,
    [refundId, paymentId, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, idempotencyKey],
  )
  if (!Array.isArray(replay) || replay.length !== 1) return null
  const row = replay[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  const record = row as Record<string, unknown>
  if (typeof record.audit_event_id !== 'string' || record.audit_event_id.length === 0 || record.audit_event_type !== 'refund_accounting_recorded' || record.audit_actor_type !== 'system' || typeof record.audit_details !== 'object' || record.audit_details === null || Array.isArray(record.audit_details)) return null
  const auditDetails = record.audit_details as Record<string, unknown>
  if (Object.keys(auditDetails).length !== 3 || auditDetails.refundPaymentId !== refundPaymentId || auditDetails.refundTxid !== refundTxid || auditDetails.horizonFeeStroops !== horizonFeeStroops) return null
  return normalizeCheckpoint(record)
}

export async function advanceRefundAuditWithAudit(
  refundId: string,
  paymentId: string,
  idempotencyKey: string,
  refundPaymentId: string,
  refundTxid: string,
  payerUid: string,
  amount: number,
  horizonFeeStroops: number,
  event: RefundAuditEvent,
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || !(await verifyRefundAccountingSchema()) || !event.eventId || event.eventType !== 'refund_audit_recorded' || event.actorType !== 'system' || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || typeof horizonFeeStroops !== 'number' || !Number.isSafeInteger(horizonFeeStroops) || horizonFeeStroops < 0 || typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) return null
  const details = event.details as Record<string, unknown>
  if (Object.keys(details).length !== 3 || details.refundPaymentId !== refundPaymentId || details.refundTxid !== refundTxid || details.horizonFeeStroops !== horizonFeeStroops) return null
  const params = [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, event.eventId, event.eventType, event.actorType, event.createdAt, event.details]
  const result = await query(`
    WITH eligible AS (
      SELECT c.refund_id FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
      WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5
        AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='accounting_recorded' AND c.status='pending'
        AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint AND r.currency='π'
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5)=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5)=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5 AND a.details->>'horizonFeeStroops'=$8::text)=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded')=0
    ), transitioned AS (
      UPDATE refund_checkpoints SET stage='audit_recorded', updated_at=NOW() WHERE refund_id IN (SELECT refund_id FROM eligible) RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $9, refund_id, payment_id, $10, $11, idempotency_key, $12, $13::jsonb FROM transitioned RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`, params)
  if (Array.isArray(result) && result.length > 1) return null
  if (Array.isArray(result) && result.length === 1) return normalizeCheckpoint(result[0])
  const diagnostic = await query(`SELECT EXISTS (SELECT 1 FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5 AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='accounting_recorded' AND c.status='pending' AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint AND r.currency='π') AS base_match, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_submission_confirmed') AS refund_submission_confirmed_total, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_submission_confirmed' AND payment_id=$2 AND idempotency_key=$3 AND event_id <> '' AND actor_type='system' AND details->>'refundPaymentId'=$4 AND details->>'refundTxid'=$5) AS refund_submission_confirmed_exact, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_payment_checkpoint_updated') AS refund_payment_checkpoint_updated_total, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_payment_checkpoint_updated' AND payment_id=$2 AND idempotency_key=$3 AND event_id <> '' AND actor_type='system' AND details->>'refundPaymentId'=$4 AND details->>'refundTxid'=$5) AS refund_payment_checkpoint_updated_exact, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_accounting_recorded') AS refund_accounting_recorded_total, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_accounting_recorded' AND payment_id=$2 AND idempotency_key=$3 AND event_id <> '' AND actor_type='system' AND details->>'refundPaymentId'=$4 AND details->>'refundTxid'=$5 AND details->>'horizonFeeStroops'=$8::text) AS refund_accounting_recorded_exact, (SELECT count(*) FROM refund_audit_events WHERE refund_id=$1 AND event_type='refund_audit_recorded') AS refund_audit_recorded_total`, params.slice(0, 8))
  const diagnosticRow = Array.isArray(diagnostic) && diagnostic.length === 1 ? diagnostic[0] as Record<string, unknown> : null
  console.warn('[refunds/audit-advance] Diagnostic:', diagnosticRow && { baseMatch: diagnosticRow.base_match, refundSubmissionConfirmedTotal: diagnosticRow.refund_submission_confirmed_total, refundSubmissionConfirmedExact: diagnosticRow.refund_submission_confirmed_exact, refundPaymentCheckpointUpdatedTotal: diagnosticRow.refund_payment_checkpoint_updated_total, refundPaymentCheckpointUpdatedExact: diagnosticRow.refund_payment_checkpoint_updated_exact, refundAccountingRecordedTotal: diagnosticRow.refund_accounting_recorded_total, refundAccountingRecordedExact: diagnosticRow.refund_accounting_recorded_exact, refundAuditRecordedTotal: diagnosticRow.refund_audit_recorded_total })
  const eventDiagnostics = await query(`SELECT event_type, payment_id=$2 AS "paymentIdMatch", idempotency_key=$3 AS "idempotencyKeyMatch", event_id <> '' AS "eventIdNonEmpty", actor_type='system' AS "actorSystem", details->>'refundPaymentId'=$4 AS "refundPaymentIdMatch", details->>'refundTxid'=$5 AS "refundTxidMatch", CASE WHEN event_type='refund_accounting_recorded' THEN details->>'horizonFeeStroops'=$6::text ELSE NULL END AS "feeMatch" FROM refund_audit_events WHERE refund_id=$1 AND event_type IN ('refund_submission_confirmed','refund_payment_checkpoint_updated','refund_accounting_recorded')`, [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, horizonFeeStroops])
  const eventDiagnosticRows = Array.isArray(eventDiagnostics) ? eventDiagnostics.filter((event): event is Record<string, unknown> & { event_type: string } => event !== null && typeof event === 'object' && !Array.isArray(event) && 'event_type' in event && typeof event.event_type === 'string') : []
  console.warn('[refunds/audit-advance] Event diagnostics:', Object.fromEntries(eventDiagnosticRows.map(event => [event.event_type, { paymentIdMatch: event.paymentIdMatch, idempotencyKeyMatch: event.idempotencyKeyMatch, eventIdNonEmpty: event.eventIdNonEmpty, actorSystem: event.actorSystem, refundPaymentIdMatch: event.refundPaymentIdMatch, refundTxidMatch: event.refundTxidMatch, ...(event.event_type === 'refund_accounting_recorded' ? { feeMatch: event.feeMatch } : {}) }])))
  const detailsDiagnostics = await query(`SELECT event_type, jsonb_typeof(details) AS details_type, CASE WHEN jsonb_typeof(details)='object' THEN ARRAY(SELECT key FROM jsonb_object_keys(details) key ORDER BY key) ELSE ARRAY[]::text[] END AS detail_keys FROM refund_audit_events WHERE refund_id=$1 AND event_type IN ('refund_submission_confirmed','refund_payment_checkpoint_updated','refund_accounting_recorded')`, [refundId])
  console.warn('[refunds/audit-advance] Details diagnostics:', Array.isArray(detailsDiagnostics) ? detailsDiagnostics : [])
  let legacyCount = 0
  let submissionConfirmed = false
  let paymentCheckpointUpdated = false
  let accountingRecorded = false
  let legacyMatches = true
  const legacyDetailsRows = await query(`SELECT event_type, details FROM refund_audit_events WHERE refund_id=$1 AND event_type IN ('refund_submission_confirmed','refund_payment_checkpoint_updated','refund_accounting_recorded')`, [refundId])
  if (Array.isArray(legacyDetailsRows)) for (const row of legacyDetailsRows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || !('event_type' in row) || !('details' in row) || typeof row.event_type !== 'string' || typeof row.details !== 'string') { legacyMatches = false; continue }
    try {
      const parsed: unknown = JSON.parse(row.details)
      const parsedObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      const paymentIdMatch = parsedObject && 'refundPaymentId' in parsed && parsed.refundPaymentId === refundPaymentId
      const refundTxidMatch = parsedObject && 'refundTxid' in parsed && parsed.refundTxid === refundTxid
      const feeMatch = row.event_type === 'refund_accounting_recorded' && parsedObject && 'horizonFeeStroops' in parsed && String(parsed.horizonFeeStroops) === String(horizonFeeStroops)
      legacyCount += 1
      if (row.event_type === 'refund_submission_confirmed') submissionConfirmed = !submissionConfirmed
      if (row.event_type === 'refund_payment_checkpoint_updated') paymentCheckpointUpdated = !paymentCheckpointUpdated
      if (row.event_type === 'refund_accounting_recorded') accountingRecorded = !accountingRecorded
      if (!parsedObject || !paymentIdMatch || !refundTxidMatch || (row.event_type === 'refund_accounting_recorded' && !feeMatch)) legacyMatches = false
    } catch { legacyMatches = false }
  }
  if (legacyCount === 3 && submissionConfirmed && paymentCheckpointUpdated && accountingRecorded && legacyMatches) await query(`WITH candidate AS (SELECT ctid, event_type, details FROM refund_audit_events WHERE refund_id=$1 AND payment_id=$2 AND idempotency_key=$3 AND actor_type='system' AND event_id<>'' AND jsonb_typeof(details)='string' AND event_type IN ('refund_submission_confirmed','refund_payment_checkpoint_updated','refund_accounting_recorded')), eligible AS (SELECT count(*)=3 AND count(*) FILTER (WHERE event_type='refund_submission_confirmed')=1 AND count(*) FILTER (WHERE event_type='refund_payment_checkpoint_updated')=1 AND count(*) FILTER (WHERE event_type='refund_accounting_recorded')=1 AS ok FROM candidate) UPDATE refund_audit_events a SET details=(c.details #>> '{}')::jsonb FROM candidate c CROSS JOIN eligible e WHERE e.ok AND a.ctid=c.ctid`, [refundId, paymentId, idempotencyKey])
  const replay = await query(`
    SELECT c.* FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
    WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5 AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='audit_recorded' AND c.status='pending'
      AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint AND r.currency='π'
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5)=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5)=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5 AND a.details->>'horizonFeeStroops'=$8::text)=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.event_id <> '' AND a.actor_type='system' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5 AND a.details->>'horizonFeeStroops'=$8::text)=1 LIMIT 2`, params.slice(0, 8))
  if (!Array.isArray(replay) || replay.length !== 1) return null
  const checkpoint = normalizeCheckpoint(replay[0])
  return checkpoint ?? null
}

export async function completeRefundCheckpointWithAudit(
  refundId: string,
  paymentId: string,
  idempotencyKey: string,
  refundPaymentId: string,
  refundTxid: string,
  payerUid: string,
  amount: number,
  horizonFeeStroops: number,
  event: RefundAuditEvent,
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || !(await verifyRefundAccountingSchema()) || !event.eventId || event.eventType !== 'refund_completed' || event.actorType !== 'system' || event.refundId !== refundId || event.paymentId !== paymentId || event.idempotencyKey !== idempotencyKey || !Number.isSafeInteger(horizonFeeStroops) || horizonFeeStroops < 0 || typeof event.details !== 'object' || event.details === null || Array.isArray(event.details)) return null
  const details = event.details as Record<string, unknown>
  if (Object.keys(details).length !== 3 || details.refundPaymentId !== refundPaymentId || details.refundTxid !== refundTxid || details.horizonFeeStroops !== horizonFeeStroops) return null
  const params = [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, event.eventId, event.eventType, event.actorType, event.createdAt, event.details]
  const auditIdentity = `(a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.actor_type='system' AND a.event_id <> '' AND a.details->>'refundPaymentId'=$4 AND a.details->>'refundTxid'=$5)`
  const result = await query(`
    WITH eligible AS (
      SELECT c.refund_id FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
      WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5
        AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='audit_recorded' AND c.status='pending'
        AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint AND r.currency='π'
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed' AND ${auditIdentity})=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated' AND ${auditIdentity})=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded' AND ${auditIdentity} AND a.details->>'horizonFeeStroops'=$8::text)=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded' AND ${auditIdentity} AND a.details->>'horizonFeeStroops'=$8::text)=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_completed')=0
    ), transitioned AS (
      UPDATE refund_checkpoints SET status='completed', updated_at=NOW() WHERE refund_id IN (SELECT refund_id FROM eligible) RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $9, refund_id, payment_id, $10, $11, idempotency_key, $12, $13::jsonb FROM transitioned RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`, params)
  if (Array.isArray(result) && result.length > 1) return null
  if (Array.isArray(result) && result.length === 1) return normalizeCheckpoint(result[0])
  const replay = await query(`
    SELECT c.* FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
    WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5 AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='audit_recorded' AND c.status='completed'
      AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint AND r.currency='π'
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_submission_confirmed' AND ${auditIdentity})=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_payment_checkpoint_updated' AND ${auditIdentity})=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_accounting_recorded' AND ${auditIdentity} AND a.details->>'horizonFeeStroops'=$8::text)=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_audit_recorded' AND ${auditIdentity} AND a.details->>'horizonFeeStroops'=$8::text)=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_completed')=1
      AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_completed' AND ${auditIdentity} AND a.details->>'horizonFeeStroops'=$8::text)=1 LIMIT 2`, params.slice(0, 8))
  if (!Array.isArray(replay) || replay.length !== 1) return null
  return normalizeCheckpoint(replay[0]) ?? null
}

export async function finalizeRefundProjectionWithAudit(refundId: string, paymentId: string, idempotencyKey: string, refundPaymentId: string, refundTxid: string, payerUid: string, amount: number): Promise<{ insertedNow: boolean } | null> {
  if (!(await verifyRefundTables()) || !(await verifyRefundAccountingSchema())) return null
  const eventId = `refund:${refundId}:projection_finalized`
  const details = { refundPaymentId, refundTxid }
  const result = await query(`
    WITH eligible AS (
      SELECT c.refund_id FROM refund_checkpoints c JOIN refund_accounting_records r ON r.refund_id=c.refund_id
      WHERE c.refund_id=$1 AND c.payment_id=$2 AND c.idempotency_key=$3 AND c.refund_payment_id=$4 AND c.refund_txid=$5 AND c.payer_uid=$6 AND c.amount=$7::numeric AND c.stage='audit_recorded' AND c.status='completed'
        AND r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.currency='π' AND r.horizon_fee_stroops>=0
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_completed')=1
        AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_completed' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.actor_type='system' AND a.event_id<>'' AND a.details=jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'horizonFeeStroops',r.horizon_fee_stroops))=1
        AND ((SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_projection_finalized')=0 OR ((SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_type='refund_projection_finalized')=1 AND (SELECT count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id AND a.event_id=$8 AND a.event_id<>'' AND a.event_type='refund_projection_finalized' AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key AND a.actor_type='system' AND a.details=jsonb_build_object('refundPaymentId',$4,'refundTxid',$5))=1))
    ), inserted AS (
      INSERT INTO refund_audit_events (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $8, refund_id, payment_id, 'refund_projection_finalized', 'system', idempotency_key, NOW(), $9::jsonb FROM eligible
      ON CONFLICT (event_id) DO NOTHING RETURNING event_id
    ) SELECT (SELECT count(*) FROM eligible) AS eligible_count, (SELECT count(*) FROM inserted) AS inserted_count`,
    [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, payerUid, amount, eventId, details],
  )
  if (!Array.isArray(result) || result.length !== 1 || Number((result[0] as Record<string, unknown>).eligible_count) !== 1) return null
  const insertedNow = Number((result[0] as Record<string, unknown>).inserted_count) === 1
  if (insertedNow) console.log('REFUND_COMPLETED', refundId)
  if (insertedNow) return { insertedNow }
  const replay = await query(`SELECT event_id FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_projection_finalized' AND ((SELECT count(*) FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_projection_finalized')=1) AND event_id=$1 AND event_id<>'' AND payment_id=$3 AND actor_type='system' AND idempotency_key=$4 AND details=jsonb_build_object('refundPaymentId',$5,'refundTxid',$6) LIMIT 2`, [eventId, refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid])
  return Array.isArray(replay) && replay.length === 1 ? { insertedNow: false } : null
}

export async function transitionRefundCheckpointWithAudit(
  refundId: string,
  fromStage: RefundCheckpoint['stage'],
  toStage: RefundCheckpoint['stage'],
  status: RefundCheckpoint['status'],
  event: RefundAuditEvent,
  patch: { refundPaymentId?: string; refundTxid?: string; lastErrorCode?: string; lastErrorMessage?: string; nextRetryAt?: string } = {},
): Promise<RefundCheckpoint | null> {
  if (!(await verifyRefundTables()) || event.refundId !== refundId || event.paymentId === '' || event.idempotencyKey === '') return null
  const fromIndex = STAGE_ORDER.indexOf(fromStage)
  const toIndex = STAGE_ORDER.indexOf(toStage)
  if (fromIndex < 0 || toIndex !== fromIndex + 1) return null
  const result = await query(`
    WITH transitioned AS (
      UPDATE refund_checkpoints SET stage=$2, status=$3, updated_at=NOW(),
        refund_payment_id=COALESCE($4, refund_payment_id), refund_txid=COALESCE($5, refund_txid),
        last_error_code=COALESCE($6, last_error_code), last_error_message=COALESCE($7, last_error_message),
        next_retry_at=COALESCE($8, next_retry_at)
      WHERE refund_id=$1 AND payment_id=$9 AND idempotency_key=$10 AND stage=$11 AND status NOT IN ('failed','completed','manual_review_required')
      RETURNING *
    ), audited AS (
      INSERT INTO refund_audit_events
        (event_id, refund_id, payment_id, event_type, actor_type, idempotency_key, created_at, details)
      SELECT $12, refund_id, payment_id, $13, $14, idempotency_key, $15, $16::jsonb FROM transitioned
      RETURNING refund_id
    ) SELECT transitioned.* FROM transitioned JOIN audited USING (refund_id)`,
    [refundId, toStage, status, patch.refundPaymentId ?? null, patch.refundTxid ?? null,
      patch.lastErrorCode ?? null, patch.lastErrorMessage ?? null, patch.nextRetryAt ?? null,
      event.paymentId, event.idempotencyKey, fromStage, event.eventId, event.eventType,
      event.actorType, event.createdAt, event.details],
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

export type PaymentRefundCheckpointLookup =
  | { state: 'absent' }
  | { state: 'present'; checkpoint: RefundCheckpoint }
  | { state: 'uncertain' }

export async function findRefundCheckpointByPaymentId(paymentId: string): Promise<PaymentRefundCheckpointLookup> {
  if (!process.env.DATABASE_URL || typeof paymentId !== 'string' || paymentId.trim() === '') return { state: 'uncertain' }
  try {
    const result = await query('SELECT * FROM refund_checkpoints WHERE payment_id = $1 LIMIT 1', [paymentId])
    if (!Array.isArray(result)) return { state: 'uncertain' }
    if (result.length === 0) return { state: 'absent' }
    const row = result[0]
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return { state: 'uncertain' }
    const checkpoint = normalizeCheckpoint(row as Record<string, unknown>)
    return checkpoint ? { state: 'present', checkpoint } : { state: 'uncertain' }
  } catch {
    return { state: 'uncertain' }
  }
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
    [event.eventId, event.refundId, event.paymentId, event.eventType, event.actorType, event.idempotencyKey, event.createdAt, event.details],
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
