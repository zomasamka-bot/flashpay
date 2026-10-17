import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const src = readFileSync(new URL('../lib/refund-checkpoint-store.ts', import.meta.url), 'utf8')
const accounting = src.slice(src.indexOf('export async function advanceRefundAccountingWithAudit('), src.indexOf('export async function advanceRefundAuditWithAudit('))
const audit = src.slice(src.indexOf('export async function advanceRefundAuditWithAudit('), src.indexOf('export async function ', src.indexOf('export async function advanceRefundAuditWithAudit(') + 1) > 0 ? src.indexOf('export async function ', src.indexOf('export async function advanceRefundAuditWithAudit(') + 1) : undefined)
const cases = [
  ['accounting', accounting, 'payment_checkpoint_updated', 'accounting_recorded', 'matching'],
  ['audit', audit, 'accounting_recorded', 'audit_recorded', 'eligible'],
]
for (const [name, body, from, to, cte] of cases) {
  const re = new RegExp(`UPDATE refund_checkpoints SET stage='${to}', updated_at=NOW\\(\\)\\s+WHERE refund_id IN \\(SELECT refund_id FROM ${cte}\\)\\s+AND stage='${from}' AND status='pending' RETURNING \\*`)
  assert.match(body, re, `${name}: guarded SQL missing`)
  const weakened = body.replace(`AND stage='${from}' AND status='pending' RETURNING *`, 'RETURNING *')
  assert.doesNotMatch(weakened, re, `${name}: mutation must be detected`)
  assert.match(body, /INSERT INTO refund_audit_events/, `${name}: audit insert missing`)
  console.log(`R36_PG04_${name.toUpperCase()}_GUARD_SOURCE=PASS mutation_detected=true`)
}
console.log('R36_PG04_SOURCE_REGRESSION=PASS scope=static_only')
