import fs from 'node:fs'
const store = fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const db = fs.readFileSync('lib/db.ts','utf8')
const list = store.slice(store.indexOf('export async function listAutomaticRefundCheckpoints'), store.indexOf('export async function getRefundCheckpointsByPaymentIds'))
const retire = store.slice(store.indexOf('export async function retirePoisonedAutomaticRefundIntent'), store.indexOf('export async function deferAutomaticRefund'))
const ensure = 'await ensureRefundCheckpointTables()'
const listEnsure = list.indexOf(ensure)
const listRead = list.indexOf('SELECT * FROM refund_checkpoints')
const listRetirementRead = list.indexOf('SELECT 1 FROM refund_automatic_retirements r')
const retireEnsure = retire.indexOf(ensure)
const retireInsert = retire.indexOf('INSERT INTO refund_automatic_retirements')
const checks = [
  ['single_schema_owner', db.includes('CREATE TABLE IF NOT EXISTS refund_automatic_retirements')],
  ['ensure_imported', store.includes("ensureRefundCheckpointTables, query, readSettlementRefundAuthority")],
  ['list_ensure_before_read', listEnsure >= 0 && listRead > listEnsure && listRetirementRead > listEnsure],
  ['retire_ensure_before_insert', retireEnsure >= 0 && retireInsert > retireEnsure],
  ['fail_closed_list', list.includes("if (!(await ensureRefundCheckpointTables())) return { state: 'uncertain' }")],
  ['fail_closed_retire', retire.includes("if (!(await ensureRefundCheckpointTables())) return { outcome: 'INDETERMINATE' }")],
]
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) process.exitCode = 1
}
if (!process.exitCode) console.log('FIN4_R4T1_REFUND_RETIREMENT_SCHEMA_ORDER PASS')
