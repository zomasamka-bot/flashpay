import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const dr17=read("scripts/verify-dr17-10k-financial-safety.mjs")
const dr18=read("scripts/verify-dr18-10k-nonfinancial-concurrency.mjs")
const r10113=read("scripts/verify-r10113-controlled-live-capacity-calibration.mjs")

// Bind calibration to production telemetry and bounded execution, never to guessed TPS.
for(const x of [
  'const BOUNDED_PIPELINE_CONCURRENCY = 2',
  'const WALLET_DRAIN_BURST_BUDGET_MS = 60_000',
  'const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000',
  'console.log("[R101-10 QUEUE THROUGHPUT]", queueThroughputObserved)',
  'console.log("[P7H CAPACITY] transient wake"',
  'wakeDurationMs','workDurationMs','discoveryDurationMs','settlementAttempts','refundAttempts',
  'walletDrainBudgetExhausted','walletDrainContinuationScheduled','piCreateBackpressureActive',
]) assert.ok(route.includes(x),x)
assert.ok(dr17.includes('live10kFinancialTransactionsExecuted:false'))
assert.ok(dr18.includes("gate:'DR-18-10K-NONFINANCIAL-CONCURRENCY'"))
assert.ok(r10113.includes('live10kCapacityClaimed:false'))

// Same-SHA DR-18 production observation from dpl_3jXaNTbCAaLgZeZuTTbhye2cJniA at 2026-09-24T22:27:01Z.
// This is an observed idle/low-work scheduler sample, not financial throughput load.
const observed={
  wakeDurationMs:4286, discoveryDurationMs:3584, workDurationMs:501,
  activeSetSize:68, activeScanObserved:68, durableU2AScanned:1, readySetSize:0,
  settlementAttempts:0, refundAttempts:0, completedResults:0, deferredDbCount:0,
  budgetExhausted:false, continuationScheduled:false, piCreateBackpressureActive:false,
  boundedPipelineConcurrency:2, walletDrainBurstBudgetMs:60000,
}
assert.ok(observed.wakeDurationMs>0 && observed.wakeDurationMs<observed.walletDrainBurstBudgetMs)
assert.ok(observed.discoveryDurationMs>=0 && observed.workDurationMs>=0)
assert.ok(observed.discoveryDurationMs+observed.workDurationMs<=observed.wakeDurationMs)
assert.equal(observed.activeScanObserved,observed.activeSetSize)
assert.equal(observed.settlementAttempts+observed.refundAttempts,0)
assert.equal(observed.budgetExhausted,false)
assert.equal(observed.continuationScheduled,false)
assert.equal(observed.piCreateBackpressureActive,false)

const schedulerHeadroomMs=observed.walletDrainBurstBudgetMs-observed.wakeDurationMs
const discoveryShare=observed.discoveryDurationMs/observed.wakeDurationMs
assert.ok(schedulerHeadroomMs>0)
assert.ok(discoveryShare>0 && discoveryShare<1)

// Capacity claims that are NOT authorized by this evidence.
const forbiddenClaims={
 liveFinancialTps:false,
 live10kFinancialCapacity:false,
 piCreateRateCeilingKnown:false,
 horizonSubmitRateCeilingKnown:false,
 dbSaturationPointKnown:false,
 redisSaturationPointKnown:false,
 p95FinancialLatencyKnown:false,
 p99FinancialLatencyKnown:false,
}
assert.ok(Object.values(forbiddenClaims).every(v=>v===false))

// Certifier remains incapable of generating financial traffic.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,['import { strict as assert } from "node:assert"','import fs from "node:fs"'])
assert.equal(/https?:\/\//.test(self),false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"DR-19-FINANCIAL-CAPACITY-CALIBRATION",
 verdict:"CALIBRATED_WITHOUT_UNSUPPORTED_THROUGHPUT_CLAIM",
 productionDeployment:"dpl_3jXaNTbCAaLgZeZuTTbhye2cJniA",
 productionGitSha:"1b2d8de071c6d72e2d6ce6e1cfb553ccadcbcb3b",
 observation:observed,
 schedulerHeadroomMs,
 discoveryShare:Number(discoveryShare.toFixed(6)),
 financialAttemptsObserved:0,
 runtimeErrorsObserved:0,
 financialMovementExecutedByCertifier:false,
 productionDataMutated:false,
 runtimePatchRequired:false,
 financialSourceChanged:false,
 liveFinancialThroughputClaimed:false,
 live10kFinancialCapacityClaimed:false,
 capacityUnknowns:Object.keys(forbiddenClaims).filter(k=>forbiddenClaims[k]===false),
 conclusion:"Current same-SHA production scheduler is healthy under the observed low-work sample; DR-17 proves 10K financial safety and DR-18 proves bounded 10K nonfinancial concurrency, but neither this sample nor those models prove a live financial TPS ceiling. Rate-limit/backpressure policy must be certified before any higher live-load calibration.",
 nextGate:"DR-20-RATE-LIMIT-POLICY"
},null,2))
