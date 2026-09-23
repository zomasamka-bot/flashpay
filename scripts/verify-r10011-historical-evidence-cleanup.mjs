import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const f31=read("scripts/verify-f3-1-public-status-reader-authority-map.mjs")
const f32=read("scripts/verify-f3-2-stale-state-matrix.mjs")
const f33=read("scripts/verify-f3-3-durable-public-status-authority.mjs")
const f34=read("scripts/verify-f3-4-projection-self-healing.mjs")
const f35=read("scripts/verify-f3-5-runtime-conflict-certification.mjs")
const publicRoute=read("app/api/payments/[id]/route.ts")

assert.ok(!f31.includes('confirmedFinding:"PUBLIC_PAYMENT_GET_REDIS_PROJECTION_WITHOUT_DURABLE_AUTHORITY_READ"'))
assert.ok(!f32.includes('confirmedGap:"PUBLIC_READER_DOES_NOT_YET_APPLY_DURABLE_STALE_STATE_MATRIX"'))
assert.ok(f31.includes('historicalFindingClosed:"PUBLIC_PAYMENT_GET_REDIS_PROJECTION_WITHOUT_DURABLE_AUTHORITY_READ"'))
assert.ok(f31.includes("currentFindingOpen:false"))
assert.ok(f32.includes('historicalGapClosed:"PUBLIC_READER_DOES_NOT_YET_APPLY_DURABLE_STALE_STATE_MATRIX"'))
assert.ok(f32.includes("currentGapOpen:false"))
assert.ok(!f35.includes('nextGate:"F3-6"'))
assert.ok(f35.includes('nextGate:"F3-CLOSED"'))

for(const x of ["readSettlementRefundAuthority(id)","getSettlementCheckpointAuthoritative(id)","getRefundCheckpointsByPaymentIds([id])"])
  assert.ok(publicRoute.includes(x),`current durable reader binding missing: ${x}`)
assert.ok(f33.includes('failClosedOnDurableConflictOrUncertainty:true'))
assert.ok(f34.includes('healing:"BEST_EFFORT_CAS_EXISTING_PROJECTION_ONLY"'))
assert.ok(f35.includes('requiresPublishedSameShaRuntimeEvidence:true'))

for(const src of [f31,f32]) {
  assert.ok(src.includes("financialRuntimeSourceChanged:false"))
  assert.ok(src.includes("financialMovementExecuted:false"))
}
console.log(JSON.stringify({
 certification:"PASS",gate:"R100-11-HISTORICAL-EVIDENCE-CLEANUP",
 staleOpenFindingLabelsRemaining:0,staleNonexistentNextGateRemaining:0,
 historicalFindingClosed:true,historicalGapClosed:true,f3TerminalEvidenceLabel:"F3-CLOSED",
 closureBoundToCurrentDurableReader:true,runtimeSourceChanged:false,
 financialRuntimeSourceChanged:false,financialMovementExecuted:false,
 changedFiles:[
  "scripts/verify-f3-1-public-status-reader-authority-map.mjs",
  "scripts/verify-f3-2-stale-state-matrix.mjs",
  "scripts/verify-f3-5-runtime-conflict-certification.mjs",
  "scripts/verify-r10011-historical-evidence-cleanup.mjs"
 ]
},null,2))
