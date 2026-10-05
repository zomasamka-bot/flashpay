import fs from 'node:fs'
const lock=fs.readFileSync('lib/pi-wallet-submit-lock.ts','utf8'),probe=fs.readFileSync('lib/fin4-r4t-lock-probe.ts','utf8'),a2u=fs.readFileSync('lib/a2u-executor.ts','utf8'),refund=fs.readFileSync('lib/refund-executor.ts','utf8')
const checks=[
 ['same_production_lock',probe.includes('acquirePiWalletSubmitLock(sourceWallet)')],
 ['no_pi_create',!probe.includes('/v2/payments')&&!probe.includes('executeA2U')],
 ['no_horizon_submit',!probe.includes('submitTransaction')&&!probe.includes('Horizon')],
 ['settlement_binding',a2u.includes('acquirePiWalletIntentSubmitLock(appPublicKey')],
 ['refund_binding',refund.includes('acquirePiWalletIntentSubmitLock(refundPayment.from_address')],
 ['token_safe_release',lock.includes('if current == ARGV[1] then')&&lock.includes('return redis.call("DEL", KEYS[1])')],
 ['distinct_process_observable',probe.includes('processId:PROCESS_ID')],
]
for(const [n,ok] of checks){console.log(`FIN4_R4T_FIXTURE ${n}=${ok?'PASS':'FAIL'}`);if(!ok)process.exitCode=1}
if(!process.exitCode)console.log('FIN4_R4T_FIXTURE_REDESIGN=PASS')
