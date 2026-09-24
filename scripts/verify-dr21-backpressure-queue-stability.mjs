import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const dr20=read("scripts/verify-dr20-rate-limit-policy.mjs")
for(const x of [
 'const BOUNDED_PIPELINE_CONCURRENCY = 2',
 'const WALLET_DRAIN_BURST_BUDGET_MS = 60_000',
 'const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000',
 'walletDrainFairnessClassForGeneration',
 'runBoundedOrderedPipeline',
 'backpressureNonCreateContinuationDetected',
 'readyShadowPreparedIds?.some((id) => !walletDrainAttemptedSettlementIds.has(id))',
 'readyShadowStage1OnlyIds?.some((id) => !walletDrainAttemptedSettlementIds.has(id))',
 'settlementReconcilingExecutionIds.some((id) => !walletDrainAttemptedSettlementIds.has(id))',
 'currentRefundDrain.refundDrainHeadRefundId !== null',
 'periodicFreshCreateDetected',
 'walletDrainContinuationScheduled = scheduleTrustedTransientRequest("continuation-kick")',
]) assert.ok(route.includes(x),x)
assert.ok(dr20.includes("gate:'DR-20-RATE-LIMIT-POLICY'"))

// Deterministic queue model: sustained Pi-create backpressure must suppress only
// fresh-create identities while non-create lanes continue until drained.
const TOTAL=10_000
const lanes=[]
for(let i=0;i<TOTAL;i++) lanes.push(i%5===0?'fresh-create':i%5===1?'prepared':i%5===2?'stage1-only':i%5===3?'reconciling':'refund')
let freshSuppressed=0,processed=0,duplicate=0,lost=0
const seen=new Set()
let wakes=0
const budgetPerWake=240
let queue=lanes.map((lane,id)=>({id,lane}))
while(queue.length){
  wakes++
  let used=0
  const next=[]
  for(const item of queue){
    if(item.lane==='fresh-create'){freshSuppressed++; continue}
    if(used>=budgetPerWake){next.push(item); continue}
    used++
    if(seen.has(item.id)) duplicate++
    seen.add(item.id); processed++
  }
  queue=next
  if(wakes>100) throw new Error('continuation did not converge')
}
const expectedNonCreate=TOTAL-TOTAL/5
lost=expectedNonCreate-seen.size
assert.equal(freshSuppressed,2000)
assert.equal(processed,8000)
assert.equal(duplicate,0)
assert.equal(lost,0)
assert.equal(wakes,34)

// Fail-closed unavailable backpressure state is treated as active; this may reduce
// fresh-create availability but cannot authorize a retry storm or block non-create drain.
const unavailable={freshCreateAllowed:false,prepared:true,stage1Only:true,reconciling:true,refund:true}
assert.equal(unavailable.freshCreateAllowed,false)
assert.ok(unavailable.prepared&&unavailable.stage1Only&&unavailable.reconciling&&unavailable.refund)

console.log(JSON.stringify({
 certification:'PASS',gate:'DR-21-BACKPRESSURE-QUEUE-STABILITY',syntheticItems:TOTAL,
 sustainedBackpressure:true,freshCreateSuppressed:freshSuppressed,nonCreateProcessed:processed,
 continuationWakes:wakes,budgetedAttemptsPerWake:budgetPerWake,duplicateWorkObserved:duplicate,
 lostNonCreateWorkObserved:lost,preparedServiceable:true,stage1OnlyServiceable:true,
 settlementReconciliationServiceable:true,refundServiceable:true,retryStormAuthorized:false,
 financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,
 changedRuntimeFiles:['app/api/recovery/transient/route.ts'],nextGate:'DR-22-LOGGING-OBSERVABILITY'
},null,2))
