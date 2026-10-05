import fs from 'node:fs'
const probe=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8')
const checks=[
 ['eval_read_only',probe.includes("redis.call('EXISTS', KEYS[1])")&&probe.includes("redis.call('TTL', KEYS[1])")&&probe.includes('redis.eval<[], [number,number]>')],
 ['no_direct_ttl',!probe.includes('redis.ttl(')],
 ['no_lock_value_read',!probe.includes("redis.call('GET', KEYS[1])")&&!probe.includes('redis.get(submitKey(sourceWallet))')],
 ['no_diagnostic_mutation',!probe.includes("redis.call('SET'")&&!probe.includes("redis.call('DEL'")&&!probe.includes("redis.call('EXPIRE'")&&!probe.includes("redis.call('PEXPIRE'")&&!probe.includes("redis.call('INCR'")&&!probe.includes("redis.call('DECR'")],
 ['exact_free_semantics',probe.includes("exists===0&&ttl===-2")&&probe.includes("state:'free',ttlSeconds:-2")],
 ['busy_semantics',probe.includes("exists===1&&ttl>=-1")&&probe.includes("state:'busy',ttlSeconds:ttl")],
 ['malformed_fail_closed',probe.includes("errorCode:'MALFORMED_DIAGNOSTIC'")],
 ['eval_failure_classified',probe.includes("errorCode:'REDIS_EVAL_FAILED'")],
 ['no_error_detail_leak',!probe.includes('String(error)')&&!probe.includes('error.message')],
 ['production_lock_reused',probe.includes('acquirePiWalletSubmitLock(sourceWallet)')],
]
for(const [n,ok] of checks){console.log(`FIN4_R4T5 ${n}=${ok?'PASS':'FAIL'}`);if(!ok)process.exitCode=1}
if(!process.exitCode) console.log('FIN4_R4T5_LOCK_DIAGNOSTIC_EVAL=PASS')
