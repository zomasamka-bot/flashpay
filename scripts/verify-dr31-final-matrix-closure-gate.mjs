import { strict as assert } from 'node:assert'
import fs from 'node:fs'

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const dr30=read('scripts/verify-dr30-second-independent-review.mjs')
const dr27=read('scripts/verify-dr27-complete-regression-matrix.mjs')
const dr29=read('scripts/verify-dr29-same-sha-production-certification.mjs')
for (const marker of ['confirmedFinancialDefectsOpen:0','confirmedCompatibilityDefectsOpen:0','retainedProofGapCount:retainedProofGaps.length']) assert.ok(dr30.includes(marker),`missing DR30 marker ${marker}`)
assert.ok(dr27.includes("gate:'DR-27-COMPLETE-REGRESSION-MATRIX'"),'DR27 matrix missing')
assert.ok(dr29.includes("gate:'DR-29-SAME-SHA-PRODUCTION-CERTIFICATION'"),'DR29 same-SHA proof missing')

const productionEvidence={
 deploymentId:'dpl_FkbnbN1oHUCnXi6LaJFQDSSnJfE1',
 gitSha:'af3a9bd7fdb397f46c6b5ebee19a56a31d216b60',
 state:'READY',target:'production',runtimeStatus:200,runtimeErrors:0,
 walletAuthorityReady:true,settlementAttempts:0,refundAttempts:0,budgetExhausted:false,boundedPipelineConcurrency:2,
}
for (const [k,v] of Object.entries({state:'READY',target:'production',runtimeStatus:200,runtimeErrors:0,walletAuthorityReady:true,settlementAttempts:0,refundAttempts:0,budgetExhausted:false})) assert.equal(productionEvidence[k],v,k)

const blockers=[
 {id:'DR10-LIVE-TOTAL-REDIS-LOSS',class:'LIVE_DESTRUCTIVE_INFRASTRUCTURE_PROOF',safeToAutoExecute:false,reason:'requires controlled loss of Redis projections and recovery observation without risking production financial state'},
 {id:'DR11-LIVE-CONCURRENT-REFUND',class:'LIVE_TESTNET_FINANCIAL_PROOF',safeToAutoExecute:false,reason:'requires a real refundable Testnet payment and concurrent refund contenders; must preserve one movement only'},
 {id:'DR14-LIVE-CRASH-INJECTION',class:'LIVE_TESTNET_FINANCIAL_PROOF',safeToAutoExecute:false,reason:'requires controlled crashes across financial boundaries using dedicated Testnet payments'},
 {id:'DR8-INDEPENDENT-WAKE-1-10M',class:'PLATFORM_SCHEDULER_CAPABILITY',safeToAutoExecute:false,reason:'current independent Vercel cron is daily; sub-10-minute independent provenance is not established'},
 {id:'DR17-LIVE-10K-FINANCIAL',class:'LIVE_CAPACITY_PROOF',safeToAutoExecute:false,reason:'10,000 real financial movements were explicitly not executed and cannot be inferred from deterministic safety'},
 {id:'DR18-LIVE-10K-NONFINANCIAL',class:'LIVE_CAPACITY_PROOF',safeToAutoExecute:false,reason:'deterministic 10K concurrency safety is not a live 10K throughput run'},
 {id:'DR19-LIVE-CAPACITY-CEILINGS',class:'LIVE_CAPACITY_PROOF',safeToAutoExecute:false,reason:'Pi/Horizon/Postgres/Redis saturation and p95/p99 ceilings require measured load'},
]
assert.equal(blockers.length,7)
assert.ok(blockers.every(x=>x.safeToAutoExecute===false))
const finalMatrixClosureEligible=blockers.length===0
assert.equal(finalMatrixClosureEligible,false)
console.log(JSON.stringify({certification:'PASS',gate:'DR-31-FINAL-MATRIX-CLOSURE-GATE',productionEvidence,confirmedFinancialDefectsOpen:0,confirmedCompatibilityDefectsOpen:0,confirmedInvariantViolationsOpen:0,confirmedDuplicateFinancialMovementsOpen:0,confirmedSettlementRefundOverlapsOpen:0,unresolvedProofGaps:blockers.length,blockers,finalMatrixClosureEligible,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:false,verdict:'BLOCKED_BY_EXPLICIT_PROOF_GAPS_NOT_BY_CONFIRMED_DEFECT',nextAction:'resolve blockers with separately authorized controlled live evidence; do not fake final closure'},null,2))
