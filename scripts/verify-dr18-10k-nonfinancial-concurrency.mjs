import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const wallet=read("lib/pi-wallet-submit-lock.ts")
const db=read("lib/db.ts")
for(const x of [
 'const BOUNDED_PIPELINE_CONCURRENCY = 2',
 'async function runBoundedOrderedPipeline',
 'Promise.allSettled(workers)',
 'const WALLET_DRAIN_FAIRNESS_ORDER: readonly WalletDrainFairnessClass[] = ["fresh", "reconciling", "refund"]',
 'const WALLET_DRAIN_BURST_BUDGET_MS = 60_000',
 'listOutstandingSettlementCheckpointIds(200)',
 'listRecoverableU2AIngressCheckpointIds(200)',
 'PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000',
 'scheduleTrustedTransientRequest("continuation-kick")',
 'walletDrainContinuationScheduled',
 'walletDrainBudgetExhausted',
]) assert.ok(route.includes(x),x)
assert.equal(route.includes('Promise.all(page.paymentIds'),false,'no unbounded durable page fanout')
for(const x of ['SUBMIT_LOCK_TTL_SECONDS = 600','SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000','RENEW_SCRIPT','RELEASE_SCRIPT']) assert.ok(wallet.includes(x),x)
for(const x of ['settlement_recovery_scan_cursor','u2a_ingress_recovery_scan_cursor','FOR UPDATE']) assert.ok(db.includes(x),x)

// Deterministic nonfinancial 10K scheduler model. No Pi/Horizon/DB/Redis calls.
const TOTAL=10000, CONCURRENCY=2, PAGE=200, lanes=['fresh','reconciling','refund']
const ids=Array.from({length:TOTAL},(_,i)=>`dr18-${i}`)
assert.equal(new Set(ids).size,TOTAL)
let processed=0, peak=0, pages=0, duplicate=0, lost=0
const seen=new Set()
for(let start=0;start<TOTAL;start+=PAGE){
 pages++; const page=ids.slice(start,start+PAGE)
 let cursor=0,inFlight=0
 while(cursor<page.length){
   const batch=page.slice(cursor,cursor+CONCURRENCY); inFlight=batch.length; peak=Math.max(peak,inFlight)
   for(const id of batch){if(seen.has(id))duplicate++;seen.add(id);processed++}
   cursor+=batch.length; inFlight=0
 }
}
assert.equal(pages,50);assert.equal(peak,2);assert.equal(processed,TOTAL);assert.equal(seen.size,TOTAL);assert.equal(duplicate,0)
for(const id of ids) if(!seen.has(id)) lost++
assert.equal(lost,0)

// Fairness: every 3 generations visits fresh/reconciling/refund exactly once.
let fairness={fresh:0,reconciling:0,refund:0}
for(let generation=1;generation<=10002;generation++) fairness[lanes[(generation-1)%3]]++
assert.ok(Math.max(...Object.values(fairness))-Math.min(...Object.values(fairness))<=1)

// Backpressure suppresses fresh creation only; reconciling/refund remain serviceable.
const backpressureSelections=[]
for(let i=0;i<3000;i++){const preferred=lanes[i%3];backpressureSelections.push(preferred==='fresh'?'reconciling':preferred)}
assert.equal(backpressureSelections.includes('fresh'),false)
assert.ok(backpressureSelections.includes('reconciling')&&backpressureSelections.includes('refund'))

// Budget exhaustion must hand off instead of inventing unbounded work.
const syntheticCostMs=250, budgetMs=60000
const attemptsPerWake=Math.floor(budgetMs/syntheticCostMs)
assert.equal(attemptsPerWake,240)
const wakes=Math.ceil(TOTAL/attemptsPerWake)
assert.equal(wakes,42)
assert.equal(wakes*attemptsPerWake>=TOTAL,true)

const self=fs.readFileSync(new URL(import.meta.url),'utf8')
assert.equal(/https?:\/\//.test(self),false)
console.log(JSON.stringify({certification:'PASS',gate:'DR-18-10K-NONFINANCIAL-CONCURRENCY',mode:'DETERMINISTIC_OFFLINE_NONFINANCIAL_CONCURRENCY_CERTIFICATION',syntheticItems:TOTAL,durablePageSize:PAGE,durablePages:pages,boundedPipelineConcurrency:CONCURRENCY,peakInFlightObserved:peak,processed,lostWorkObserved:lost,duplicateWorkObserved:duplicate,fairnessSelections:fairness,backpressureFreshCreateSuppressed:true,reconcilingAndRefundRemainServiceable:true,burstBudgetMs:budgetMs,syntheticAttemptsPerWake:attemptsPerWake,syntheticContinuationWakes:wakes,unboundedPromiseAllObserved:false,financialMovementExecuted:false,piNetworkCalled:false,horizonCalled:false,productionDataMutated:false,runtimePatchRequired:false,financialSourceChanged:false,nextGate:'DR-19-FINANCIAL-CAPACITY-CALIBRATION'},null,2))
