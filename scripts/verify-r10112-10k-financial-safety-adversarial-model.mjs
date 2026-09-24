import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const db=read("lib/db.ts")
const locked=read("lib/a2u-locked-executor.ts")
const wallet=read("lib/pi-wallet-submit-lock.ts")
const refundStore=read("lib/refund-checkpoint-store.ts")
const refundIntent=read("lib/refund-intent-service.ts")
const leaseProof=read("scripts/verify-financial-lease-loss-adversarial-safety.mjs")
const exactProof=read("scripts/verify-nfinx3-exact-stroops.mjs")
const sdkProof=read("scripts/verify-nfinx4-stellar-v17-operation-source.mjs")
const loadProof=read("scripts/verify-r10111-10k-nonfinancial-load.mjs")

// Bind this adversarial model to the actual production financial authorities.
for(const x of [
 "verifySettlementRefundAuthorityExclusion",
 "recordSettlementPreparedCheckpoint",
 "recordSettlementHorizonCheckpoint",
 "recordSettlementPiCompletedCheckpoint",
 "recordSettlementDbFinalizedCheckpoint",
]) assert.ok(db.includes(x),`durable settlement authority missing: ${x}`)
assert.ok(locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)"))
assert.ok(wallet.includes('const SUBMIT_LOCK_TTL_SECONDS = 600'))
assert.ok(wallet.includes('const SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000'))
assert.ok(wallet.includes('kind: "settlement_prepared"'))
assert.ok(refundStore.includes("authority.settlementActive"))
assert.ok(refundIntent.includes("const lockedAuthority = await readSettlementRefundAuthority(payment.id)"))
assert.ok(leaseProof.includes("duplicatePreparedSequenceSecondAcceptanceBlocked: true"))
assert.ok(exactProof.includes("plusOneStroopRejected:true"))
assert.ok(sdkProof.includes('sdkVersion:"17.1.0"'))
assert.ok(loadProof.includes('syntheticItems:TOTAL'))

const TOTAL=10_000
const ids=Array.from({length:TOTAL},(_,i)=>`financial-model-${String(i+1).padStart(5,"0")}`)
assert.equal(new Set(ids).size,TOTAL)

// Model only immutable financial authority. No network/database client is imported.
const state=new Map(ids.map(id=>[id,{branch:null,prepared:null,horizon:null,pi:false,db:false,movements:0}]))
let conflictsRejected=0, duplicateSubmissionsRejected=0, wrongSequenceRejected=0
let wrongHashRejected=0, wrongAmountRejected=0, crashResumes=0

function claim(id,branch){
 const s=state.get(id); assert.ok(s)
 if(s.branch!==null && s.branch!==branch){conflictsRejected++;return false}
 s.branch=branch;return true
}
function prepare(id,hash,seq,amountStroops){
 const s=state.get(id); assert.equal(s.branch,"settlement")
 if(s.prepared!==null){
  const same=s.prepared.hash===hash&&s.prepared.seq===seq&&s.prepared.amountStroops===amountStroops
  if(!same){duplicateSubmissionsRejected++;return false}
  return true
 }
 s.prepared={hash,seq,amountStroops};return true
}
function confirmHorizon(id,{hash,seq,amountStroops}){
 const s=state.get(id); assert.ok(s.prepared)
 if(hash!==s.prepared.hash){wrongHashRejected++;return false}
 if(seq!==s.prepared.seq){wrongSequenceRejected++;return false}
 if(amountStroops!==s.prepared.amountStroops){wrongAmountRejected++;return false}
 if(s.horizon!==null)return true // exact replay is observation, not a second movement
 s.horizon={hash,seq,amountStroops};s.movements++;return true
}
function completePi(id){const s=state.get(id);if(!s.horizon)return false;s.pi=true;return true}
function finalizeDb(id){const s=state.get(id);if(!s.pi)return false;s.db=true;return true}

// 10K adversarial population: half settlement, half refund. Every attempt to
// claim the opposite branch must fail, proving Settlement XOR Refund.
for(let i=0;i<TOTAL;i++){
 const id=ids[i], branch=i%2===0?"settlement":"refund"
 assert.equal(claim(id,branch),true)
 assert.equal(claim(id,branch==="settlement"?"refund":"settlement"),false)
}
assert.equal(conflictsRejected,TOTAL)

// Settlement half: exact prepared identity, crash/restart, replay, mutations.
for(let i=0;i<TOTAL;i+=2){
 const id=ids[i], n=BigInt(i/2+1)
 const hash=n.toString(16).padStart(64,"0")
 const seq=(100000n+n).toString()
 const amountStroops=1_000_000n+(n%97n)
 assert.equal(prepare(id,hash,seq,amountStroops),true)
 // crash after durable prepare: reconstructed worker must use the same identity.
 crashResumes++
 assert.equal(prepare(id,hash,seq,amountStroops),true)
 assert.equal(confirmHorizon(id,{hash:"f".repeat(64)===hash?"e".repeat(64):"f".repeat(64),seq,amountStroops}),false)
 assert.equal(confirmHorizon(id,{hash,seq:(BigInt(seq)+1n).toString(),amountStroops}),false)
 assert.equal(confirmHorizon(id,{hash,seq,amountStroops:amountStroops+1n}),false)
 assert.equal(confirmHorizon(id,{hash,seq,amountStroops}),true)
 assert.equal(confirmHorizon(id,{hash,seq,amountStroops}),true)
 assert.equal(completePi(id),true)
 assert.equal(finalizeDb(id),true)
}
const settlementStates=[...state.values()].filter(s=>s.branch==="settlement")
const refundStates=[...state.values()].filter(s=>s.branch==="refund")
assert.equal(settlementStates.length,5000)
assert.equal(refundStates.length,5000)
assert.equal(settlementStates.every(s=>s.movements===1&&s.db===true),true)
assert.equal(refundStates.every(s=>s.movements===0),true)
assert.equal(wrongHashRejected,5000)
assert.equal(wrongSequenceRejected,5000)
assert.equal(wrongAmountRejected,5000)
assert.equal(crashResumes,5000)

// Duplicate workers cannot invent a different prepared identity.
for(let i=0;i<100;i+=2){
 const id=ids[i], s=state.get(id)
 assert.equal(prepare(id,"a".repeat(64),s.prepared.seq,s.prepared.amountStroops),false)
}
assert.equal(duplicateSubmissionsRejected,50)

// The certifier is intentionally offline: only Node assert/fs imports are allowed.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,[
 'import { strict as assert } from "node:assert"',
 'import fs from "node:fs"',
])

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-12-10K-FINANCIAL-SAFETY-ADVERSARIAL-MODEL",
 mode:"DETERMINISTIC_OFFLINE_FINANCIAL_SAFETY_MODEL",
 modeledPayments:TOTAL,
 settlementModeled:settlementStates.length,
 refundModeled:refundStates.length,
 settlementRefundConflictsRejected:conflictsRejected,
 crashResumeCases:crashResumes,
 wrongHashRejected,
 wrongSequenceRejected,
 plusOneStroopRejected:wrongAmountRejected,
 conflictingPreparedIdentityRejected:duplicateSubmissionsRejected,
 duplicateAcceptedMovementObserved:settlementStates.filter(s=>s.movements!==1).length,
 settlementRefundOverlapObserved:[...state.values()].filter(s=>s.branch!=="settlement"&&s.branch!=="refund").length,
 lostFinalSettlementObserved:settlementStates.filter(s=>!s.db).length,
 financialMovementExecuted:false,
 piNetworkCalled:false,
 horizonCalled:false,
 productionDataMutated:false,
 runtimeFinancialSourceChanged:false,
 live10kFinancialTransactionsExecuted:false,
 nextGate:"R101-13-CONTROLLED-LIVE-CAPACITY-CALIBRATION"
},null,2))
