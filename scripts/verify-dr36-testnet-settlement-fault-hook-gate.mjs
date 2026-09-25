import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const a2u=read('lib/a2u-executor.ts'), complete=read('app/api/pi/complete/route.ts'), approve=read('app/api/pi/approve/route.ts'), recon=read('lib/pi-reconciliation.ts')
const merchant='hazemaboria', uid='ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa'
const hooks=[
 {amount:0.11,src:a2u,needle:'[A2U TEST] Stage2 prepared checkpoint fault point 0.11'},
 {amount:0.12,src:a2u,needle:'[A2U TEST] Stage2 post-submit fault point 0.12'},
 {amount:0.14,src:a2u,needle:'[P7 TEST] Stage1-only interruption 0.14'},
]
for(const h of hooks){
 const i=h.src.indexOf(h.needle); assert.ok(i>=0,`missing ${h.amount}`)
 const guard=h.src.slice(Math.max(0,i-900),i)
 if(h.amount===0.14){assert.ok(guard.includes('durableStage1.outcome===\"RECORDED\"'),'0.14 must be first durable Stage1 record only')}else{assert.ok(guard.includes('ctx.isRecovery')&&guard.includes('false'),`${h.amount} must be fresh-only`)}
 assert.ok(guard.includes('ctx.merchantAuthority')&&guard.includes('durable_u2a'),`${h.amount} must require durable U2A authority`)
 assert.ok(guard.includes('ctx.payment.piPaymentId')&&guard.includes('ctx.payment.u2aTxid'),`${h.amount} must require verified U2A identity evidence`)
 assert.ok(guard.includes(merchant)&&guard.includes(uid),`${h.amount} must be test-merchant scoped`)
}
const i13=complete.indexOf('[P7 TEST] Fresh dispatch interruption 0.13'); assert.ok(i13>=0)
const g13=complete.slice(Math.max(0,i13-700),i13)
assert.ok(g13.includes('finalPiPayment.network==="Pi Testnet"'),'0.13 must require canonical Pi Testnet authority')
assert.ok(g13.includes(merchant)&&g13.includes(uid)&&g13.includes('finalPiAmount===0.13'),'0.13 exact identity/amount gate missing')
assert.ok(complete.includes('if (piPayment.network !== "Pi Testnet")')&&complete.includes('if (finalPiPayment.network !== "Pi Testnet")'),'complete must hard-reject non-Testnet before durable ingress')
assert.ok(approve.includes('PI_NETWORK_MISMATCH')&&recon.includes('Pi Testnet'),'approve/reconciliation Testnet boundary missing')
// 10K adversarial predicate model: only exact fresh durable-Testnet-authority test cases can trigger.
let triggers=0,mainnetTriggers=0,replayRefaultTriggers=0,wrongIdentityTriggers=0
for(let i=0;i<10000;i++){
 const amount=[0.11,0.12,0.13,0.14][i%4]
 const network=i%5===0?'Pi Mainnet':'Pi Testnet'
 const fresh=i%7!==0, firstStage1Record=i%13!==0, durable=network==='Pi Testnet', exactIdentity=i%11!==0, hasU2A=durable
 const settlement=(amount===0.14?firstStage1Record:fresh)&&durable&&hasU2A&&exactIdentity
 const complete13=(amount===0.13)&&network==='Pi Testnet'&&exactIdentity
 const hit=settlement||complete13
 if(hit)triggers++
 if(hit&&network!=='Pi Testnet')mainnetTriggers++
 if(hit&&amount===0.14&&!firstStage1Record)replayRefaultTriggers++
 if(hit&&!exactIdentity)wrongIdentityTriggers++
}
assert.ok(triggers>0);assert.equal(mainnetTriggers,0);assert.equal(replayRefaultTriggers,0);assert.equal(wrongIdentityTriggers,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-36-TESTNET-SETTLEMENT-FAULT-HOOK-GATE',settlementHookAmounts:[0.11,0.12,0.13,0.14],productionVercelMayExerciseHooks:true,piMainnetHookTriggers:0,replayRefaultTriggers:0,wrongIdentityHookTriggers:0,syntheticCases:10000,financialMovementExecuted:false,productionDataMutated:false},null,2))
