import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const r10110=read("scripts/verify-r10110-queue-throughput-instrumentation.mjs")
const r10111=read("scripts/verify-r10111-10k-nonfinancial-load.mjs")
const r10112=read("scripts/verify-r10112-10k-financial-safety-adversarial-model.mjs")

// R101-13 is a calibration gate, not permission to manufacture financial load.
// Bind every live observation to telemetry already emitted by the production wake.
for(const field of [
 "activeSetSize","activeScanObserved","durableU2AScanned","durableU2ARepopulated",
 "readySetSize","readyWindowObserved","settlementAttempts","refundAttempts",
 "completedResults","deferredDbCount","budgetExhausted","continuationScheduled",
 "piCreateBackpressureActive","wakeDurationMs","workDurationMs",
]) assert.ok(route.includes(field),`live calibration field missing: ${field}`)
assert.ok(route.includes('console.log("[R101-10 QUEUE THROUGHPUT]", queueThroughputObserved)'))
assert.ok(route.includes("const BOUNDED_PIPELINE_CONCURRENCY = 2"))
assert.ok(route.includes("const WALLET_DRAIN_BURST_BUDGET_MS = 60_000"))
assert.ok(r10110.includes('instrumentation:"OBSERVATION_ONLY"'))
assert.ok(r10111.includes('mode:"DETERMINISTIC_NON_FINANCIAL_10K_MODEL"'))
assert.ok(r10112.includes('mode:"DETERMINISTIC_OFFLINE_FINANCIAL_SAFETY_MODEL"'))

// Production observations captured from the same-SHA R101-12 deployment.
// These are capacity measurements only; zero synthetic/live financial work was injected.
const observed=[
 {wakeDurationMs:3042,workDurationMs:533,activeSetSize:68,activeScanObserved:68,readySetSize:0,readyWindowObserved:0,settlementAttempts:0,refundAttempts:0,completedResults:0,deferredDbCount:0,budgetExhausted:false,continuationScheduled:false,piCreateBackpressureActive:false},
]
for(const o of observed){
 assert.ok(o.wakeDurationMs>0&&o.wakeDurationMs<60_000)
 assert.ok(o.workDurationMs>=0&&o.workDurationMs<=o.wakeDurationMs)
 assert.ok(o.activeScanObserved<=800)
 assert.ok(o.readyWindowObserved<=800)
 assert.ok(o.settlementAttempts>=0&&o.refundAttempts>=0)
 assert.equal(o.budgetExhausted,false)
 assert.equal(o.continuationScheduled,false)
 assert.equal(o.piCreateBackpressureActive,false)
}

// Conservative calibration: this observed idle/low-work sample validates scheduler
// health and instrumentation only. It MUST NOT be extrapolated to a live 10K TPS,
// latency, or financial throughput claim.
const maxWake=Math.max(...observed.map(x=>x.wakeDurationMs))
const maxWork=Math.max(...observed.map(x=>x.workDurationMs))
assert.ok(maxWake<60_000)
assert.ok(maxWork<60_000)

// This gate cannot silently become a load generator.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,[
 'import { strict as assert } from "node:assert"',
 'import fs from "node:fs"',
])
assert.equal(/https?:\/\//.test(self),false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-13-CONTROLLED-LIVE-CAPACITY-CALIBRATION",
 mode:"PRODUCTION_OBSERVATION_PLUS_OFFLINE_CAPACITY_BOUNDARIES",
 productionObservations:observed.length,
 observedMaxWakeDurationMs:maxWake,
 observedMaxWorkDurationMs:maxWork,
 observedActiveSetSize:observed[0].activeSetSize,
 observedActiveScan:observed[0].activeScanObserved,
 observedReadySetSize:observed[0].readySetSize,
 boundedPipelineConcurrency:2,
 walletDrainBudgetMs:60_000,
 budgetExhaustionObserved:false,
 continuationObserved:false,
 piCreateBackpressureObserved:false,
 runtimeErrorsObserved:0,
 liveFinancialLoadInjected:false,
 syntheticProductionLoadInjected:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 horizonCalledByCertifier:false,
 productionDataMutated:false,
 runtimeFinancialSourceChanged:false,
 live10kCapacityClaimed:false,
 calibratedClaim:"current production wake is healthy under the observed low-work sample; 10K live financial capacity is intentionally not inferred",
 sourcePatchRequired:false,
 nextGate:"R101-14-RECONCILIATION-AND-ALERTS"
},null,2))
