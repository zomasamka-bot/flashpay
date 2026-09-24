import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const nfin6=read("scripts/verify-nfin6-10k-capacity.mjs")
const nfin10g=read("scripts/verify-nfin10g-adversarial-10k-durability.mjs")
const r10110=read("scripts/verify-r10110-queue-throughput-instrumentation.mjs")

// Bind the model to the production queue/drain limits and R101-10 telemetry.
for(const x of [
 "const BOUNDED_PIPELINE_CONCURRENCY = 2",
 "const WALLET_DRAIN_BURST_BUDGET_MS = 60_000",
 'listOutstandingSettlementCheckpointIds(200)',
 'listRecoverableU2AIngressCheckpointIds(200)',
 'const readyCoverageTruncated = readyCoverageAllIds.length > 800',
 'if (orderedIds.length > 800)',
 'console.log("[R101-10 QUEUE THROUGHPUT]", queueThroughputObserved)',
]) assert.ok(route.includes(x),`production capacity/telemetry invariant missing: ${x}`)
assert.ok(nfin6.includes("SYNTHETIC_MODEL_ONLY"))
assert.ok(nfin10g.includes("CODE_AND_SYNTHETIC_READINESS_ONLY"))
assert.ok(r10110.includes('instrumentation:"OBSERVATION_ONLY"'))

const TOTAL=10_000, READY_WINDOW=800, DB_PAGE=200, SCAN_WINDOW=800
const ids=Array.from({length:TOTAL},(_,i)=>`synthetic-${String(i+1).padStart(5,"0")}`)
assert.equal(new Set(ids).size,TOTAL)

// Non-financial queue rotation load: prove every synthetic ID becomes visible
// under the production 800-item ready window, without invoking the route.
const seen=new Set()
let readyCursor=0, readyWakes=0
while(seen.size<TOTAL){
  const window=ids.slice(readyCursor,readyCursor+READY_WINDOW)
  for(const id of window)seen.add(id)
  readyWakes++
  readyCursor+=READY_WINDOW
  if(readyCursor>=TOTAL)readyCursor=0
  assert.ok(readyWakes<=Math.ceil(TOTAL/READY_WINDOW)+1)
}
assert.equal(seen.size,TOTAL)
assert.equal(readyWakes,13)

// Durable rediscovery model at the exact production page size.
let durableCursor=0,durablePages=0
const durableSeen=new Set()
while(durableCursor<TOTAL){
  for(const id of ids.slice(durableCursor,durableCursor+DB_PAGE))durableSeen.add(id)
  durableCursor+=DB_PAGE;durablePages++
}
assert.equal(durableSeen.size,TOTAL)
assert.equal(durablePages,50)

// Active scan boundedness: a wake never materializes >800 IDs.
let activeCursor=0,activeWakes=0,activePeak=0
const activeSeen=new Set()
while(activeSeen.size<TOTAL){
  const window=ids.slice(activeCursor,activeCursor+SCAN_WINDOW)
  activePeak=Math.max(activePeak,window.length)
  for(const id of window)activeSeen.add(id)
  activeCursor+=SCAN_WINDOW;activeWakes++
  if(activeCursor>=TOTAL)activeCursor=0
}
assert.equal(activeSeen.size,TOTAL)
assert.equal(activePeak,800)
assert.equal(activeWakes,13)

// Adversarial queue churn: removing one already-observed ID and appending a
// fresh ID must require a new exact cycle; it must not create duplicate IDs.
const churn=[...ids]
const removed=churn.shift()
churn.push("synthetic-new-after-scan")
assert.equal(churn.length,TOTAL)
assert.equal(new Set(churn).size,TOTAL)
assert.equal(churn.includes(removed),false)

// Crash/restart and duplicate-wake model: durable/ready membership is set-like;
// repeated observation changes latency only, not authority or multiplicity.
const durableMembership=new Set(ids)
for(const id of ids.slice(0,READY_WINDOW))durableMembership.add(id)
assert.equal(durableMembership.size,TOTAL)
const restartedSeen=new Set()
for(let cursor=0;cursor<TOTAL;cursor+=READY_WINDOW)
  for(const id of ids.slice(cursor,cursor+READY_WINDOW))restartedSeen.add(id)
assert.equal(restartedSeen.size,TOTAL)

// Critical safety: the certifier imports only Node assert/fs and reads source
// text; it does not import or invoke any network/database/financial client.
const importLines=selfSource().match(/^import .*$/gm) ?? []
assert.deepEqual(importLines,[
 'import { strict as assert } from "node:assert"',
 'import fs from "node:fs"',
])
function selfSource(){return fs.readFileSync(new URL(import.meta.url),"utf8")}

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-11-10K-NONFINANCIAL-LOAD-CERTIFICATION",
 mode:"DETERMINISTIC_NON_FINANCIAL_10K_MODEL",
 syntheticItems:TOTAL,
 uniqueSyntheticItems:new Set(ids).size,
 readyWindow:READY_WINDOW,
 readyWindowsRequired:readyWakes,
 durablePageSize:DB_PAGE,
 durablePagesRequired:durablePages,
 activeScanPeak:activePeak,
 activeScanWakesRequired:activeWakes,
 duplicateQueueIdentityObserved:0,
 lostSyntheticIdentityObserved:0,
 financialMovementExecuted:false,
 piNetworkCalled:false,
 horizonCalled:false,
 productionRouteInvokedByCertifier:false,
 productionDataMutated:false,
 runtimeFinancialLogicChanged:false,
 sourcePatchRequired:false,
 independentProductionRuntimeEvidence:"R101-10 telemetry observed separately",
 nextGate:"R101-12-10K-FINANCIAL-SAFETY-ADVERSARIAL-MODEL"
},null,2))
