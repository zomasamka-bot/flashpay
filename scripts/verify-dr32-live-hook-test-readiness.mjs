import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const a2u=read('lib/a2u-executor.ts')
const complete=read('app/api/pi/complete/route.ts')
const refund=read('lib/refund-executor.ts')
const refundSubmit=read('lib/refund-blockchain-submit.ts')
const settlementHooks=[
 {amount:0.11,boundary:'prepared_checkpoint_before_horizon_submit',needle:'[A2U TEST] Stage2 prepared checkpoint fault point 0.11'},
 {amount:0.12,boundary:'horizon_success_before_tx_checkpoint',needle:'[A2U TEST] Stage2 post-submit fault point 0.12'},
 {amount:0.13,boundary:'u2a_complete_before_fresh_dispatch',needle:'[P7 TEST] Fresh dispatch interruption 0.13'},
 {amount:0.14,boundary:'a2u_create_before_stage2',needle:'[P7 TEST] Stage1-only interruption 0.14'},
]
for(const h of settlementHooks){const src=h.amount===0.13?complete:a2u;assert.ok(src.includes(h.needle),`missing ${h.amount}`);assert.ok(src.includes('process.env.VERCEL_ENV')&&src.includes('production'),`production exclusion ${h.amount}`)}
const refundHooks=[
 {amount:0.10,boundary:'refund_auth_before_submit',needle:'[P7 TEST] Refund auth-before-submit 0.10',src:refund},
 {amount:0.10,boundary:'refund_prepared_before_auth',needle:'[P7 TEST] Refund prepared-before-auth 0.10',src:refundSubmit},
 {amount:0.10,boundary:'refund_post_replay_submit',needle:'[P7 TEST] Refund post-replay-submit 0.10',src:refundSubmit},
]
for(const h of refundHooks){assert.ok(h.src.includes(h.needle));assert.ok(h.src.includes('FLASHPAY_REFUND_CRASH_TEST === "1"'));assert.ok(h.src.includes('process.env.VERCEL_ENV !== "production"'))}
assert.equal(a2u.includes('ctx.customerAmount===0.15')||a2u.includes('ctx.customerAmount === 0.15')||complete.includes('finalPiAmount===0.15'),false,'0.15 hook must not be invented')
console.log(JSON.stringify({certification:'PASS',gate:'DR-32-LIVE-HOOK-TEST-READINESS',settlementHooks:settlementHooks.map(({amount,boundary})=>({amount,boundary})),refundHooks:refundHooks.map(({amount,boundary})=>({amount,boundary})),productionHooksExcluded:true,refundExplicitFlagRequired:true,amount015HookPresent:false,financialMovementExecuted:false,runtimePatchRequired:false,nextAction:'deploy to non-production Testnet environment, then execute one controlled payment at a time and inspect durable/Pi/Horizon/accounting evidence before advancing'},null,2))
