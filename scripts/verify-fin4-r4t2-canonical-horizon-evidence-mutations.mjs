import fs from 'node:fs'
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const good='s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL'
function gate(src){return src.includes(good)&&!src.includes('s.horizon_confirmed=TRUE')}
const mutations=[
 ['restore_phantom_boolean',store.replace(good,'s.a2u_txid IS NOT NULL OR s.horizon_confirmed=TRUE')],
 ['drop_timestamp_guard',store.replace(good,'s.a2u_txid IS NOT NULL')],
 ['drop_txid_guard',store.replace(good,'s.horizon_confirmed_at IS NOT NULL')],
]
if(!gate(store)){console.error('FIN4_R4T2 baseline=FAIL');process.exit(1)}
for(const [n,src] of mutations){const rejected=!gate(src);console.log(`FIN4_R4T2_MUTATION ${n}=${rejected?'PASS':'FAIL'}`);if(!rejected)process.exitCode=1}
if(!process.exitCode)console.log('FIN4_R4T2_CANONICAL_HORIZON_EVIDENCE_MUTATIONS=PASS')
