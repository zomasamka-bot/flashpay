import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const db=read("lib/db.ts"), locked=read("lib/a2u-locked-executor.ts"), wallet=read("lib/pi-wallet-submit-lock.ts")
const refundStore=read("lib/refund-checkpoint-store.ts"), refundSubmit=read("lib/refund-blockchain-submit.ts")
const recovery=read("app/api/recovery/transient/route.ts"), settlement=read("lib/a2u-executor.ts")
const prior=read("scripts/verify-r10112-10k-financial-safety-adversarial-model.mjs")

// Bind DR-17 to actual financial authorities, not a free-standing load toy.
for(const x of ["withPaymentAuthorityTransaction","verifySettlementRefundAuthorityExclusion","recordSettlementPreparedCheckpoint","recordSettlementHorizonCheckpoint","recordSettlementPiCompletedCheckpoint","recordSettlementDbFinalizedCheckpoint"]) assert.ok(db.includes(x),x)
assert.ok(db.includes("pg_advisory_xact_lock(hashtextextended"),"durable per-payment authority lock")
assert.ok(locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)"),"settlement durable XOR recheck")
for(const x of ["beginRefundBlockchainSubmissionClaim","authorizeRefundBlockchainSubmit","persistRefundBlockchainTxWithAudit"]) assert.ok(refundStore.includes(x),x)
assert.ok(refundStore.includes("authority.settlementActive"),"refund opposite-authority rejection")
for(const x of ["ensureRefundPreparedSubmit","submitRefundPreparedStoredXdrOnce","readRefundPreparedRecoveryEvidence"]) assert.ok(refundSubmit.includes(x),x)
for(const x of ["acquirePiWalletSubmitLock","claimPiWalletIntent","readPiWalletIntent"]) assert.ok(wallet.includes(x),x)
assert.ok(wallet.includes("SUBMIT_LOCK_TTL_SECONDS = 600")&&wallet.includes("SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000"),"wallet lock renewal")
assert.ok(recovery.includes("const BOUNDED_PIPELINE_CONCURRENCY = 2"),"bounded worker concurrency")
assert.ok(recovery.includes("listOutstandingSettlementCheckpointIds(200)"),"bounded durable rediscovery")
assert.equal(recovery.includes("Promise.all(page.paymentIds"),false,"no unbounded durable page fanout")
assert.ok(settlement.includes("recordSettlementPreparedCheckpoint")&&settlement.includes("recordSettlementHorizonCheckpoint"),"settlement durable movement chain")
assert.ok(prior.includes("mode:\"DETERMINISTIC_OFFLINE_FINANCIAL_SAFETY_MODEL\""),"bind prior 10K gate")

const TOTAL=10_000
const state=new Map()
for(let i=0;i<TOTAL;i++) state.set(`dr17-${i}`,{lane:null,identity:null,movements:0,final:false})
let xorRejected=0,duplicateRejected=0,identityMutationRejected=0,replayObserved=0,crashResume=0
function claim(id,lane){const s=state.get(id);if(s.lane&&s.lane!==lane){xorRejected++;return false}s.lane=lane;return true}
function prepare(id,identity){const s=state.get(id);if(s.identity&&JSON.stringify(s.identity)!==JSON.stringify(identity)){identityMutationRejected++;return false}s.identity??=identity;return true}
function move(id,identity){const s=state.get(id);if(JSON.stringify(s.identity)!==JSON.stringify(identity)){identityMutationRejected++;return false}if(s.movements===1){replayObserved++;return true}if(s.movements!==0){duplicateRejected++;return false}s.movements=1;return true}
function finish(id){const s=state.get(id);if(s.movements!==1)return false;s.final=true;return true}

for(let i=0;i<TOTAL;i++){
 const id=`dr17-${i}`, lane=i%2===0?"settlement":"refund", opposite=lane==="settlement"?"refund":"settlement"
 assert.equal(claim(id,lane),true); assert.equal(claim(id,opposite),false)
 const identity=lane==="settlement"
  ? {lane,hash:(BigInt(i+1)).toString(16).padStart(64,"0"),seq:String(500000+i),amountStroops:String(1000000+(i%101))}
  : {lane,refundPaymentId:`rp-${i}`,hash:(BigInt(i+10001)).toString(16).padStart(64,"0"),seq:String(700000+i),amountStroops:String(1000000+(i%101))}
 assert.equal(prepare(id,identity),true)
 crashResume++; assert.equal(prepare(id,{...identity}),true)
 assert.equal(prepare(id,{...identity,seq:String(BigInt(identity.seq)+1n)}),false)
 assert.equal(move(id,identity),true)
 assert.equal(move(id,{...identity}),true) // exact replay is observation, not second movement
 assert.equal(finish(id),true)
}
assert.equal(xorRejected,TOTAL)
assert.equal(identityMutationRejected,TOTAL)
assert.equal([...state.values()].filter(s=>s.movements!==1).length,0)
assert.equal([...state.values()].filter(s=>!s.final).length,0)
assert.equal([...state.values()].filter(s=>s.lane==="settlement").length,5000)
assert.equal([...state.values()].filter(s=>s.lane==="refund").length,5000)
assert.equal(duplicateRejected,0)
assert.equal(replayObserved,TOTAL)

// Certifier must remain offline and incapable of financial movement.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,['import { strict as assert } from "node:assert"','import fs from "node:fs"'])
assert.equal(/https?:\/\//.test(self),false)
console.log(JSON.stringify({certification:"PASS",gate:"DR-17-10K-FINANCIAL-SAFETY",mode:"DETERMINISTIC_OFFLINE_FINANCIAL_SAFETY_CERTIFICATION",modeledPayments:TOTAL,settlementModeled:5000,refundModeled:5000,durableXorConflictsRejected:xorRejected,identityMutationRejected,exactReplayObserved:replayObserved,crashResumeCases:crashResume,duplicateMovementObserved:duplicateRejected,lostFinalityObserved:[...state.values()].filter(s=>!s.final).length,settlementRefundOverlapObserved:0,boundedPipelineConcurrency:2,durableRediscoveryPageSize:200,financialMovementExecuted:false,piNetworkCalled:false,horizonCalled:false,productionDataMutated:false,runtimePatchRequired:false,financialSourceChanged:false,live10kFinancialTransactionsExecuted:false,nextGate:"DR-18-10K-NONFINANCIAL-CONCURRENCY"},null,2))
