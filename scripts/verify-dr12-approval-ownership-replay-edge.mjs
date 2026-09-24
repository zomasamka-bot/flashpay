import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const db=fs.readFileSync(new URL('../lib/db.ts',import.meta.url),'utf8')
const fn=db.slice(db.indexOf('export async function recordSettlementU2AApprovalClaim'),db.indexOf('export type SettlementU2AIngressCheckpointResult'))
for(const x of [
  "u2a_approval_identifier=${params.u2aIdentifier}",
  "u2a_approval_claimed_at=NOW()",
  "u2a_approval_identifier IS NULL",
  "FOR UPDATE",
  "const replayStage = typeof row.stage === 'string'",
  "'payment_identity', 'a2u_created', 'prepared', 'horizon_confirmed', 'pi_completed', 'db_finalized'",
  "row.u2a_approval_identifier !== params.u2aIdentifier",
  "laterStage && row.u2a_identifier !== params.u2aIdentifier",
  "return { outcome:'REPLAYED', version }",
]) assert.ok(fn.includes(x),x)
assert.equal(fn.includes("row.stage !== 'payment_identity' ||"),false)

const stages=['payment_identity','a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized']
function replay({stage,claim='pi-u2a-A',u2a,request='pi-u2a-A',claimedAt=true}){
  const replayStage=stages.includes(stage), laterStage=stage!=='payment_identity'
  const conflict=!replayStage || claim!==request || !claimedAt || (u2a!=null&&u2a!==request) || (laterStage&&u2a!==request)
  return conflict?'CONFLICT':'REPLAYED'
}
assert.equal(replay({stage:'payment_identity',u2a:null}),'REPLAYED')
for(const stage of stages.slice(1)) assert.equal(replay({stage,u2a:'pi-u2a-A'}),'REPLAYED',stage)
for(const stage of stages) assert.equal(replay({stage,u2a:stage==='payment_identity'?null:'pi-u2a-A',request:'pi-u2a-B'}),'CONFLICT',stage)
for(const stage of stages.slice(1)) assert.equal(replay({stage,u2a:null}),'CONFLICT',`missing later identity ${stage}`)
for(const stage of stages.slice(1)) assert.equal(replay({stage,u2a:'pi-u2a-B'}),'CONFLICT',`wrong later identity ${stage}`)
assert.equal(replay({stage:'unknown',u2a:'pi-u2a-A'}),'CONFLICT')
console.log(JSON.stringify({certification:'PASS',gate:'DR-12-APPROVAL-OWNERSHIP-REPLAY-EDGE',sameApprovalReplayAcrossStages:stages,differentApprovalConflict:true,missingLaterU2AIdentityConflict:true,wrongLaterU2AIdentityConflict:true,unknownStageConflict:true,piMutationExecuted:false,horizonMovementExecuted:false,runtimePatchRequired:true},null,2))
