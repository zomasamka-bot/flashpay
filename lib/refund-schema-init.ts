import "server-only"

import { runPostgresTransaction } from "@/lib/db"
import { getRefundSchemaDiagnostics } from "@/lib/refund-checkpoint-store"

type SchemaName = keyof Awaited<ReturnType<typeof getRefundSchemaDiagnostics>>

const OBJECTS: readonly SchemaName[] = [
  "refund_checkpoints",
  "refund_audit_events",
  "idx_refund_checkpoints_status_retry",
  "idx_refund_checkpoints_payment",
  "idx_refund_audit_payment_created",
  "idx_refund_audit_refund_created",
]

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS refund_checkpoints (
  refund_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, stage TEXT NOT NULL, payer_uid TEXT NOT NULL, payer_uid_verified_at TIMESTAMP NOT NULL,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0), currency TEXT NOT NULL DEFAULT 'π',
  source_payment_status TEXT NOT NULL, source_settlement_state TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  refund_payment_id TEXT, refund_txid TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT, last_error_message TEXT, next_retry_at TIMESTAMP
)`
const AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS refund_audit_events (
  event_id TEXT PRIMARY KEY, refund_id TEXT NOT NULL REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
  payment_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(), details JSONB NOT NULL DEFAULT '{}'::jsonb
)`
const INDEX_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_status_retry ON refund_checkpoints(status, next_retry_at)",
  "CREATE INDEX IF NOT EXISTS idx_refund_checkpoints_payment ON refund_checkpoints(payment_id)",
  "CREATE INDEX IF NOT EXISTS idx_refund_audit_payment_created ON refund_audit_events(payment_id, created_at ASC)",
  "CREATE INDEX IF NOT EXISTS idx_refund_audit_refund_created ON refund_audit_events(refund_id, created_at ASC)",
]

export async function activateRefundSchemaReadiness() {
  const before = await getRefundSchemaDiagnostics()
  if (OBJECTS.every((name) => before[name])) return { ready: true }
  const result = await runPostgresTransaction(async (tx) => {
    await tx.unsafe(TABLE_SQL)
    await tx.unsafe(AUDIT_SQL)
    for (const sql of INDEX_SQL) await tx.unsafe(sql)
    const rows = await tx.unsafe(`SELECT name, EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=name AND c.relkind=CASE WHEN name IN ('refund_checkpoints','refund_audit_events') THEN 'r' ELSE 'i' END
    ) AS present FROM unnest($1::text[]) AS names(name)`, [OBJECTS])
    if (!Array.isArray(rows) || rows.length !== OBJECTS.length || !rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row) && (row as Record<string, unknown>).present === true)) throw new Error("refund schema verification failed")
    return { ready: true }
  })
  return result ?? { ready: false }
}
