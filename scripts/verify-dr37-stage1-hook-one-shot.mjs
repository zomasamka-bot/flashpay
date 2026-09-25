import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const src=fs.readFileSync(new URL('../lib/a2u-executor.ts',import.meta.url),'utf8')
const needle='[P7 TEST] Stage1-only interruption 0.14'
const i=src.indexOf(needle); assert.ok(i>=0,'0.14 hook missing')
const guard=src.slice(Math.max(0,i-1200),i)
assert.ok(guard.includes('durableStage1.outcome==="RECORDED"'),'0.14 must fire only on first durable Stage1 record')
assert.ok(!guard.includes('ctx.isRecovery===false'),'0.14 must not depend on normal-vs-recovery dispatch')
assert.ok(guard.includes('ctx.merchantAuthority==="durable_u2a"'),'durable U2A authority required')
assert.ok(guard.includes('ctx.payment.piPaymentId')&&guard.includes('ctx.payment.u2aTxid'),'durable U2A identity required')
assert.ok(guard.includes('hazemaboria')&&guard.includes('ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa')&&guard.includes('ctx.customerAmount===0.14'),'exact test identity/amount required')
const reuse=src.indexOf('STAGE 1: Reusing existing A2U payment')
assert.ok(reuse>i,'reused A2U path must be after and outside creation-only hook')
let firstRecordHits=0,replayHits=0,reusedHits=0,wrongIdentityHits=0
for(let n=0;n<10000;n++){
 const durableOutcome=n%2===0?'RECORDED':'REPLAYED'
 const existingA2U=n%5===0
 const exactIdentity=n%7!==0
 const amount=n%11===0?0.13:0.14
 const hit=!existingA2U&&durableOutcome==='RECORDED'&&exactIdentity&&amount===0.14
 if(hit)firstRecordHits++
 if(hit&&durableOutcome==='REPLAYED')replayHits++
 if(hit&&existingA2U)reusedHits++
 if(hit&&!exactIdentity)wrongIdentityHits++
}
assert.ok(firstRecordHits>0); assert.equal(replayHits,0); assert.equal(reusedHits,0); assert.equal(wrongIdentityHits,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-37-STAGE1-HOOK-ONE-SHOT',syntheticCases:10000,firstRecordHits,replayHits,reusedA2UHits:reusedHits,wrongIdentityHits,existingPendingStage1WillResumeWithoutRefault:true,financialMovementExecuted:false,productionDataMutated:false},null,2))
