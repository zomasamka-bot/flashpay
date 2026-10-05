import fs from 'node:fs'
const probe=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8')
const holder=fs.readFileSync('app/api/certification/fin4-r4t-lock-holder/route.ts','utf8')
const contender=fs.readFileSync('app/api/certification/fin4-r4t-lock-contender/route.ts','utf8')
const lock=fs.readFileSync('lib/pi-wallet-submit-lock.ts','utf8')
const diagnosticRead=(probe.includes('redis.ttl(submitKey(sourceWallet))')||(
  probe.includes("redis.call('EXISTS', KEYS[1])")&&probe.includes("redis.call('TTL', KEYS[1])")&&probe.includes('redis.eval<[], [number,number]>')
))
const noTokenRead=!probe.includes('redis.get(submitKey(sourceWallet))')&&!probe.includes("redis.call('GET', KEYS[1])")
const checks=[
 ['production_key_read_only_diagnostic',probe.includes("const SUBMIT_KEY_PREFIX='flashpay:wallet:submit:'")&&diagnosticRead&&noTokenRead],
 ['busy_preflight',probe.includes("reason:'BUSY_PRODUCTION_LOCK'")&&probe.indexOf("reason:'BUSY_PRODUCTION_LOCK'")<probe.indexOf('acquirePiWalletSubmitLock(sourceWallet)')],
 ['race_classified',probe.includes("reason:'LOCK_RACED_BUSY'")],
 ['request_identity',probe.includes('requestId:probeRequestId')&&probe.includes('processId:PROCESS_ID')],
 ['held_owner_observable',probe.includes('heldOwner:held')&&probe.includes('readFin4R4THeld(runId)')],
 ['contender_run_bound',contender.includes('contendFin4R4TWalletProbe(runId,wallet)')],
 ['no_financial_surface',!probe.includes('/v2/payments')&&!probe.includes('submitTransaction')&&!probe.includes('executeA2U')&&!probe.includes('refund_checkpoint')],
 ['production_lock_unchanged',lock.includes('const SUBMIT_LOCK_TTL_SECONDS = 600')&&lock.includes('const SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000')],
 ['routes_node_dynamic',holder.includes("runtime='nodejs'")&&contender.includes("runtime='nodejs'")&&holder.includes("dynamic='force-dynamic'")&&contender.includes("dynamic='force-dynamic'")],
]
for(const [n,ok] of checks){console.log(`FIN4_R4T3 ${n}=${ok?'PASS':'FAIL'}`);if(!ok)process.exitCode=1}
if(!process.exitCode) console.log('FIN4_R4T3_LOCK_PROBE_DIAGNOSTICS=PASS')
