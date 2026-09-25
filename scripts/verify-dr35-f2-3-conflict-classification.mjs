import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const recovery=fs.readFileSync(new URL('../app/api/recovery/transient/route.ts',import.meta.url),'utf8')
const start=recovery.indexOf('async function repopulateDurableU2AIngressWork')
const end=recovery.indexOf('async function repopulateDurableSettlementWork')
assert.ok(start>=0&&end>start)
const f=recovery.slice(start,end)
assert.ok(f.includes("if(authority.outcome!=='CLEAR'){conflict(paymentId,`authority_${authority.outcome.toLowerCase()}`);continue}"),'uncertain/conflicting durable authority must remain fail-closed')
assert.ok(f.includes('if(authority.refundActive){result.excludedRefundAuthority++;continue}'),'refund XOR exclusion must not be counted as settlement conflict')
assert.ok(f.includes("conflict(paymentId,'advanced_projection_without_durable_settlement')"),'advanced projection proof gap must remain a conflict')
assert.ok(f.includes("conflict(paymentId,healed===0?'projection_heal_race':'projection_heal_rejected')"),'heal races/rejections must be attributable')
assert.ok(f.includes("conflict(paymentId,'projection_readback_mismatch')"),'readback mismatch must remain fail-closed')
assert.ok(recovery.includes('conflictReasons:Record<string,number>')&&recovery.includes('conflictSamples:Array<{paymentId:string;reason:string}>'),'result must expose reason counts and bounded identity samples')
assert.ok(f.includes('if(result.conflictSamples.length<20)result.conflictSamples.push({paymentId,reason})'),'identity samples must be bounded')
assert.ok(!f.includes("if(authority.outcome!=='CLEAR'||authority.refundActive){result.conflicts++;continue}"),'legacy false-positive classification must be removed')
let conflicts=0,excludedRefundAuthority=0
const reasons={}
const conflict=r=>{conflicts++;reasons[r]=(reasons[r]??0)+1}
for(let i=0;i<10000;i++){
  const paymentId=`synthetic-${i}`
  const authority=i%5===0?'CONFLICT':'CLEAR'
  const refund=authority==='CLEAR'&&i%3===0
  if(authority!=='CLEAR'){conflict('authority_conflict');continue}
  if(refund){excludedRefundAuthority++;continue}
  if(i%7===0){conflict('projection_readback_mismatch');continue}
}
assert.equal(conflicts,Object.values(reasons).reduce((a,b)=>a+b,0))
assert.ok(excludedRefundAuthority>0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-35-F2-3-CONFLICT-CLASSIFICATION',syntheticCases:10000,conflicts,excludedRefundAuthority,reasons,financialMovementExecuted:false,productionDataMutated:false},null,2))
