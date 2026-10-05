import fs from 'node:fs'
const src=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8')
function survives(s){
 const diagnosticRead=s.includes('redis.ttl(submitKey(sourceWallet))')||(s.includes("redis.call('EXISTS', KEYS[1])")&&s.includes("redis.call('TTL', KEYS[1])")&&s.includes('redis.eval<[], [number,number]>'))
 const noTokenRead=!s.includes('redis.get(submitKey(sourceWallet))')&&!s.includes("redis.call('GET', KEYS[1])")
 return s.includes("if(before.state==='busy')")&&diagnosticRead&&noTokenRead&&s.includes('requestId:probeRequestId,nonce')
}
const mutations=[
 ['remove_busy_guard',src.replace("if(before.state==='busy')", "if(false&&before.state==='busy')")],
 ['read_lock_token',src.replace("local exists = redis.call('EXISTS', KEYS[1])","local leaked = redis.call('GET', KEYS[1])\nlocal exists = redis.call('EXISTS', KEYS[1])")],
 ['remove_request_identity',src.replace('requestId:probeRequestId,nonce','nonce')],
]
let killed=0
for(const [n,s] of mutations){const ok=!survives(s);console.log(`FIN4_R4T3_MUTATION ${n}=${ok?'KILLED':'SURVIVED'}`);if(ok)killed++}
if(killed!==mutations.length)process.exitCode=1
else console.log('FIN4_R4T3_LOCK_PROBE_DIAGNOSTICS_MUTATIONS=PASS')
