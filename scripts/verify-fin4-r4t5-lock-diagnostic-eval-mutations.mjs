import fs from 'node:fs'
const src=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8')
function section(s){const a=s.indexOf('const SUBMIT_LOCK_DIAGNOSTIC_SCRIPT=`');const b=s.indexOf('`',a+'const SUBMIT_LOCK_DIAGNOSTIC_SCRIPT=`'.length);return a>=0&&b>a?s.slice(a,b+1):''}
function survives(s){const lua=section(s);return lua.includes("redis.call('EXISTS', KEYS[1])")&&lua.includes("redis.call('TTL', KEYS[1])")&&!/redis\.call\('(GET|SET|DEL|EXPIRE|PEXPIRE)/.test(lua)&&s.includes('exists===0&&ttl===-2')&&s.includes('exists===1&&ttl>=-1')&&s.includes("errorCode:'REDIS_EVAL_FAILED'")}
const mutations=[
 ['remove_exists',src.replace("local exists = redis.call('EXISTS', KEYS[1])","local exists = 0")],
 ['remove_ttl',src.replace("local ttl = redis.call('TTL', KEYS[1])","local ttl = -2")],
 ['read_token',src.replace("local exists = redis.call('EXISTS', KEYS[1])","local leaked = redis.call('GET', KEYS[1])\\nlocal exists = redis.call('EXISTS', KEYS[1])")],
 ['weaken_free',src.replace('exists===0&&ttl===-2','ttl===-2')],
 ['weaken_busy',src.replace('exists===1&&ttl>=-1','ttl>=-1')],
 ['drop_error_classification',src.replace("errorCode:'REDIS_EVAL_FAILED'","errorCode:'MALFORMED_DIAGNOSTIC'")],
]
let killed=0
for(const [n,s] of mutations){const ok=!survives(s);console.log(`FIN4_R4T5_MUTATION ${n}=${ok?'KILLED':'SURVIVED'}`);if(ok)killed++}
if(killed!==mutations.length)process.exitCode=1
else console.log('FIN4_R4T5_LOCK_DIAGNOSTIC_EVAL_MUTATIONS=PASS')
