import fs from 'node:fs'
const src=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const verifier=fs.readFileSync('scripts/verify-fin4-r4t1-refund-retirement-schema-order.mjs','utf8')
const guards=(src.match(/if \(!\(await ensureRefundCheckpointTables\(\)\)\) return/g)||[]).length
const checks=[['two_guard_sites',guards===2],['verifier_binds_list',verifier.includes('list_ensure_before_read')],['verifier_binds_retire',verifier.includes('retire_ensure_before_insert')]]
for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} mutation ${n}`);if(!ok)process.exitCode=1}
if(!process.exitCode)console.log('FIN4_R4T1_REFUND_RETIREMENT_SCHEMA_ORDER_MUTATIONS PASS')
