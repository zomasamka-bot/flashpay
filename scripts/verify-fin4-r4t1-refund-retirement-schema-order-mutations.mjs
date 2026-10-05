import fs from 'node:fs'
const src=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const verifier=fs.readFileSync('scripts/verify-fin4-r4t1-refund-retirement-schema-order.mjs','utf8')
function section(start,end){const a=src.indexOf(start);const b=src.indexOf(end,a+start.length);return a>=0&&b>a?src.slice(a,b):''}
const list=section('export async function listAutomaticRefundCheckpoints','export async function getRefundCheckpointsByPaymentIds')
const retire=section('export async function retirePoisonedAutomaticRefundIntent','export async function') || src.slice(src.indexOf('export async function retirePoisonedAutomaticRefundIntent'))
const checks=[
 ['list_guard_site',/if \(!\(await ensureRefundCheckpointTables\(\)\)\) return/.test(list)],
 ['retire_guard_site',/if \(!\(await ensureRefundCheckpointTables\(\)\)\) return/.test(retire)],
 ['verifier_binds_list',verifier.includes('list_ensure_before_read')],
 ['verifier_binds_retire',verifier.includes('retire_ensure_before_insert')],
]
for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'} mutation ${n}`);if(!ok)process.exitCode=1}
if(!process.exitCode)console.log('FIN4_R4T1_REFUND_RETIREMENT_SCHEMA_ORDER_MUTATIONS PASS')
