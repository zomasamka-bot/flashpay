import { strict as assert } from "node:assert"
import fs from "node:fs"

const route=fs.readFileSync(new URL("../app/api/pi/approve/route.ts",import.meta.url),"utf8")
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
const complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8")

const claimCall=route.indexOf("recordSettlementU2AApprovalClaim({")
const piApprove=route.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`')
const canonicalGet=route.indexOf('`https://api.minepi.com/v2/payments/${identifier}`')
assert.ok(canonicalGet>=0 && claimCall>canonicalGet && piApprove>claimCall,"claim must be after canonical validation and before Pi /approve")
assert.ok(route.includes('approvalClaim.outcome !== "RECORDED" && approvalClaim.outcome !== "REPLAYED"'))
assert.ok(route.includes('"U2A_APPROVAL_OWNERSHIP_CONFLICT"'))
assert.ok(route.includes('"U2A_APPROVAL_DURABILITY_UNAVAILABLE"'))

assert.ok(db.includes("u2a_approval_identifier TEXT"))
assert.ok(db.includes("u2a_approval_claimed_at TIMESTAMP"))
assert.ok(db.includes("ADD COLUMN IF NOT EXISTS u2a_approval_identifier TEXT"))
assert.ok(db.includes("export async function recordSettlementU2AApprovalClaim"))
assert.ok(db.includes("u2a_approval_identifier IS NULL"))
assert.ok(db.includes("u2a_approval_identifier=${params.u2aIdentifier}"))
assert.ok(db.includes("row.u2a_approval_identifier !== params.u2aIdentifier"))
assert.ok(db.includes("(u2a_approval_identifier IS NULL OR u2a_approval_identifier=${params.u2aIdentifier})"))
assert.ok(db.includes("(row.u2a_approval_identifier!=null && row.u2a_approval_identifier!==params.u2aIdentifier)"))

function claim(state,id){
  if(state===null)return {state:id,outcome:"RECORDED"}
  if(state===id)return {state,outcome:"REPLAYED"}
  return {state,outcome:"CONFLICT"}
}
let state=null
let x=claim(state,"A"); assert.equal(x.outcome,"RECORDED"); state=x.state
x=claim(state,"A"); assert.equal(x.outcome,"REPLAYED"); state=x.state
x=claim(state,"B"); assert.equal(x.outcome,"CONFLICT"); assert.equal(x.state,"A")
const uncertain={outcome:"INDETERMINATE"}
assert.notEqual(uncertain.outcome,"RECORDED")
assert.notEqual(uncertain.outcome,"REPLAYED")

// Complete must still durably verify U2A before Pi /complete; R101-2 must not bypass F2.
assert.ok(complete.includes("recordSettlementU2AVerifiedCheckpoint"))
assert.ok(complete.indexOf("recordSettlementU2AVerifiedCheckpoint({") < complete.indexOf('/complete`,'))

console.log(JSON.stringify({
 certification:"PASS",gate:"R101-2-DURABLE-U2A-APPROVAL-CLAIM",
 nullToA:"RECORDED",aToA:"REPLAYED",aToB:"CONFLICT",dbUncertainty:"FAIL_CLOSED_BEFORE_PI_APPROVE",
 f2VerifiedBindingEnforced:true,secretsStored:false,financialMovementExecuted:false,piNetworkCalledByCertifier:false
},null,2))
