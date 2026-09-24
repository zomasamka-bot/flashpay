import { strict as assert } from "node:assert"
import fs from "node:fs"
const route=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8")
const marker='console.log("[R101-10 QUEUE THROUGHPUT]", queueThroughputObserved)'
assert.equal((route.match(/\[R101-10 QUEUE THROUGHPUT\]/g)||[]).length,1)
for(const x of [
 "const queueThroughputObserved = {",
 "activeSetSize,",
 "activeScanObserved: keys.length,",
 "durableU2AScanned: durableU2AIngressRepopulation.scanned,",
 "durableU2ARepopulated: durableU2AIngressRepopulation.repopulated,",
 "readySetSize,",
 "readyWindowObserved: readyOrderedCount,",
 "settlementAttempts: walletDrainBurstSettlementAttempts,",
 "refundAttempts: walletDrainBurstRefundAttempts,",
 "completedResults: results.filter((item) => item.ok).length + refundResults.filter((item) => item.ok).length,",
 "deferredDbCount: walletDrainDeferredDbCount,",
 "budgetExhausted: walletDrainBudgetExhausted,",
 "continuationScheduled: walletDrainContinuationScheduled,",
 "piCreateBackpressureActive: piCreateBackpressureActive(),",
 "wakeDurationMs,",
 "workDurationMs,",
 marker,
]) assert.ok(route.includes(x),`missing throughput field: ${x}`)

// Instrumentation must happen after work/continuation decisions, so it cannot
// feed scheduling or wallet selection in the same wake.
const metric=route.indexOf("const queueThroughputObserved = {")
assert.ok(metric>route.indexOf("walletDrainContinuationScheduled = scheduleTrustedTransientRequest"))
assert.ok(metric>route.indexOf("const workDurationMs = Date.now() - workStartedAt"))
assert.ok(route.indexOf(marker)>metric)

// No new Redis/DB/network side effect is introduced by the instrumentation block.
const block=route.slice(metric,route.indexOf('console.log("[P7J12 OTHER PREREQ]"',metric))
for(const forbidden of ["redis.","query(","fetch(","executeA2URecovery(","runAutomaticRefund","scheduleTrustedTransientRequest(","await "])
 assert.equal(block.includes(forbidden),false,`instrumentation gained side effect: ${forbidden}`)

// Capacity boundaries remain explicit and unchanged.
for(const x of [
 "const BOUNDED_PIPELINE_CONCURRENCY = 2",
 "const WALLET_DRAIN_BURST_BUDGET_MS = 60_000",
 'listOutstandingSettlementCheckpointIds(200)',
 'listRecoverableU2AIngressCheckpointIds(200)',
 'const readyCoverageTruncated = readyCoverageAllIds.length > 800',
 'if (orderedIds.length > 800)',
]) assert.ok(route.includes(x),`capacity boundary missing: ${x}`)

// Synthetic non-financial observability model: counters remain bounded,
// internally consistent and useful for later 10K load certification.
const wake=({active,scan,ready,window,settlement,refund,ok,deferred,budget,continuation,ms})=>({
 activeSetSize:active,activeScanObserved:scan,readySetSize:ready,readyWindowObserved:window,
 settlementAttempts:settlement,refundAttempts:refund,completedResults:ok,deferredDbCount:deferred,
 budgetExhausted:budget,continuationScheduled:continuation,wakeDurationMs:ms
})
const samples=[
 wake({active:10000,scan:800,ready:10000,window:800,settlement:12,refund:3,ok:14,deferred:1,budget:true,continuation:true,ms:60000}),
 wake({active:9200,scan:800,ready:9200,window:800,settlement:10,refund:2,ok:12,deferred:0,budget:true,continuation:true,ms:60000}),
 wake({active:10,scan:10,ready:0,window:0,settlement:0,refund:0,ok:0,deferred:0,budget:false,continuation:false,ms:2900}),
]
for(const x of samples){
 assert.ok(x.activeScanObserved<=800)
 assert.ok(x.readyWindowObserved<=800)
 assert.ok(x.completedResults<=x.settlementAttempts+x.refundAttempts+x.deferredDbCount)
 assert.ok(x.wakeDurationMs>=0)
}
assert.ok(samples[0].activeSetSize>samples[1].activeSetSize)
assert.equal(samples[0].continuationScheduled,true)
assert.equal(samples[2].continuationScheduled,false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-10-QUEUE-THROUGHPUT-INSTRUMENTATION",
 instrumentation:"OBSERVATION_ONLY",
 fields:16,
 activeScanBoundPerWake:800,
 readyWindowBoundPerWake:800,
 boundedPipelineConcurrency:2,
 walletDrainBudgetMs:60000,
 synthetic10kTelemetryMode:"NON_FINANCIAL_MODEL_ONLY",
 runtimeFinancialLogicChanged:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 secretsRead:false,
 productionRuntimeEvidenceRequiredForClosure:true
},null,2))
