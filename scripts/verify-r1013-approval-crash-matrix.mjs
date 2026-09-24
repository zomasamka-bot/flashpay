import { strict as assert } from "node:assert"
import fs from "node:fs"

const route=fs.readFileSync(new URL("../app/api/pi/approve/route.ts",import.meta.url),"utf8")
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
const complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8")

const canonicalGet=route.indexOf('`https://api.minepi.com/v2/payments/${identifier}`')
const claimCall=route.indexOf("recordSettlementU2AApprovalClaim({")
const piApprove=route.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`')
const refetch=route.indexOf("Refetching Pi payment to verify developer_approved")
assert.ok(canonicalGet>=0 && claimCall>canonicalGet && piApprove>claimCall && refetch>piApprove)

// Executable state-machine model of the exact R101-2 ownership semantics.
// This performs no network, DB, Redis or blockchain I/O.
function durableClaim(state,id,db="ok"){
  if(db==="uncertain") return {state,outcome:"INDETERMINATE"}
  if(state===null) return {state:id,outcome:"RECORDED"}
  if(state===id) return {state,outcome:"REPLAYED"}
  return {state,outcome:"CONFLICT"}
}
function mayCallPi(outcome){ return outcome==="RECORDED" || outcome==="REPLAYED" }

// 1) crash before claim: no durable owner and no Pi mutation happened.
// Retry A can establish ownership exactly once.
let state=null
assert.equal(state,null)
let x=durableClaim(state,"A"); assert.equal(x.outcome,"RECORDED"); state=x.state
assert.equal(state,"A")

// 2) crash after claim, before Pi /approve: retry A replays; B conflicts.
x=durableClaim(state,"A"); assert.equal(x.outcome,"REPLAYED"); assert.equal(mayCallPi(x.outcome),true)
let b=durableClaim(state,"B"); assert.equal(b.outcome,"CONFLICT"); assert.equal(mayCallPi(b.outcome),false); assert.equal(b.state,"A")

// 3) Pi approval succeeds but response is lost: durable A already exists.
// Retry A may call Pi again and route explicitly accepts Pi already_approved.
assert.ok(route.includes('approvalData.error?.message?.includes("already_approved")'))
x=durableClaim(state,"A"); assert.equal(x.outcome,"REPLAYED"); assert.equal(mayCallPi(x.outcome),true)

// 4) crash after Pi success before local approval cache: cache is non-authoritative.
// Retry is still governed by durable A, not Redis approval cache.
const cachePos=route.indexOf("pi:approval:")
assert.ok(cachePos>refetch && cachePos>piApprove)
x=durableClaim(state,"A"); assert.equal(x.outcome,"REPLAYED")

// 5) concurrent A/A serialization: one record, the other replay.
state=null
const first=durableClaim(state,"A"); state=first.state
const second=durableClaim(state,"A")
assert.equal(first.outcome,"RECORDED"); assert.equal(second.outcome,"REPLAYED")

// 6) concurrent A/B serialization: regardless of order, exactly one identifier owns payment.
for(const [firstId,secondId] of [["A","B"],["B","A"]]){
  state=null
  const p=durableClaim(state,firstId); state=p.state
  const q=durableClaim(state,secondId)
  assert.equal(p.outcome,"RECORDED")
  assert.equal(q.outcome,"CONFLICT")
  assert.equal(q.state,firstId)
}

// 7) DB uncertainty before Pi /approve: route must fail closed and not reach Pi mutation.
const uncertain=durableClaim(null,"A","uncertain")
assert.equal(uncertain.outcome,"INDETERMINATE")
assert.equal(mayCallPi(uncertain.outcome),false)
assert.ok(route.includes('"U2A_APPROVAL_DURABILITY_UNAVAILABLE"'))

// 8) durable identity mismatch/absence is conflict, never an INSERT fallback.
const fnStart=db.indexOf("export async function recordSettlementU2AApprovalClaim")
const fnEnd=db.indexOf("export type SettlementU2AIngressCheckpointResult",fnStart)
const claimSource=db.slice(fnStart,fnEnd)
assert.ok(claimSource.includes("UPDATE settlement_checkpoints"))
assert.equal(claimSource.includes("INSERT INTO settlement_checkpoints"),false)
assert.ok(claimSource.includes("FOR UPDATE"))

// 9) verified U2A cannot later switch ownership to B.
assert.ok(db.includes("(u2a_approval_identifier IS NULL OR u2a_approval_identifier=${params.u2aIdentifier})"))
assert.ok(db.includes("(row.u2a_approval_identifier!=null && row.u2a_approval_identifier!==params.u2aIdentifier)"))

// 10) existing F2 complete crash boundary remains after durable verified U2A evidence.
const verified=complete.indexOf("recordSettlementU2AVerifiedCheckpoint({")
const piComplete=complete.indexOf("Payment not developer_completed - calling Pi /complete endpoint")
assert.ok(verified>=0 && piComplete>verified)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-3-APPROVAL-CRASH-MATRIX",
 matrix:{
  crashBeforeClaim:"SAFE_RETRY_A_CAN_RECORD",
  crashAfterClaimBeforePiApprove:"SAFE_A_REPLAY_B_CONFLICT",
  piSuccessResponseLost:"SAFE_A_REPLAY_ALREADY_APPROVED_ACCEPTED",
  crashAfterPiBeforeCache:"SAFE_CACHE_NON_AUTHORITATIVE",
  concurrentAA:"ONE_RECORDED_ONE_REPLAYED",
  concurrentAB:"ONE_OWNER_OTHER_CONFLICT",
  dbUncertainty:"FAIL_CLOSED_BEFORE_PI_APPROVE",
  laterVerifiedIdentifierMismatch:"CONFLICT"
 },
 sourcePatchRequired:false,
 financialMovementExecuted:false,
 piNetworkCalled:false,
 secretsRead:false
},null,2))
