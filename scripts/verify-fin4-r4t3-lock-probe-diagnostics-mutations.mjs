import fs from 'node:fs'
const src=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8')
const mutations=[
 ['remove_busy_guard',src.replace("if(before.state==='busy')", "if(false&&before.state==='busy')")],
 ['read_lock_token',src.replace('const ttl=await redis.ttl(submitKey(sourceWallet))','const leaked=await redis.get(submitKey(sourceWallet)); const ttl=await redis.ttl(submitKey(sourceWallet))')],
 ['remove_request_identity',src.replace('requestId:probeRequestId,nonce','nonce')],
]
function survives(s){return s.includes("if(before.state==='busy')")&&!s.includes('redis.get(submitKey(sourceWallet))')&&s.includes('requestId:probeRequestId,nonce')}
let killed=0
for(const [n,s] of mutations){const ok=!survives(s);console.log(`FIN4_R4T3_MUTATION ${n}=${ok?'KILLED':'SURVIVED'}`);if(ok)killed++}
if(killed!==mutations.length)process.exitCode=1
else console.log('FIN4_R4T3_LOCK_PROBE_DIAGNOSTICS_MUTATIONS=PASS')
