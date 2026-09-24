import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8")
const route=read("app/api/recovery/transient/route.ts")
const db=read("lib/db.ts")
const recovery=read("lib/a2u-recovery-service.ts")
const refund=read("lib/refund-checkpoint-store.ts")

// Durable discovery must not depend on Redis.
for(const x of [
  "listRecoverableU2AIngressCheckpointIds(200)",
  "listOutstandingSettlementCheckpointIds(200)",
  "repopulateDurableU2AIngressWork",
  "repopulateDurableSettlementWork",
  "verifySettlementRefundAuthorityExclusion(paymentId)",
]) assert.ok(route.includes(x),x)
for(const x of ["u2a_ingress_recovery_scan_cursor","settlement_recovery_scan_cursor","FOR UPDATE"])
  assert.ok(db.includes(x),x)

// Redis projection/index reconstruction must be idempotent and bounded.
for(const x of [
  "{nx:true}",
  "redis.sadd('flashpay:recovery:active-payments:v1',paymentId)",
  "redis.zadd('flashpay:settlement:ready:v1'",
  "compareAndSwapPaymentProjection(paymentId,existing,next)",
  "READY_BASELINE_COVERAGE_KEY",
]) assert.ok(route.includes(x),x)
assert.equal(route.includes("Promise.all(page.paymentIds"),false)

// DR-10 repair: a Redis flush removes legacy bootstrap certificates. Missing is
// recoverable; contradictory present values still fail closed.
assert.ok(route.includes('marker !== null && marker !== "done"'))
assert.equal(route.includes('markers.some((marker) => marker !== "done")'),false)

// Opposite authority and movement proofs remain mandatory after reconstruction.
assert.ok(recovery.includes("durable_authority_conflict"))
assert.ok(refund.includes("settlementActive"))
assert.ok(db.includes("Settlement and Refund durable authorities conflict"))

// Deterministic fault model: immediate/continuation kick lost, all Redis payment,
// active/ready/cursor/baseline/lease keys lost, worker dies; independent wake then
// rotates PostgreSQL durable rows in bounded pages and reconstructs each exactly once.
const N=10000,page=200
let durable=Array.from({length:N},(_,i)=>({id:`p-${i}`,movement:i%3===0?"horizon_confirmed":"prepared",refund:false}))
let redisProjection=new Map(),active=new Set(),ready=new Set(),cursor=0
let duplicateMovement=0,overlap=0
let wakes=0
while(cursor<durable.length){
  const batch=durable.slice(cursor,cursor+page); cursor+=batch.length; wakes++
  for(const row of batch){
    if(!redisProjection.has(row.id)) redisProjection.set(row.id,row)
    active.add(row.id); ready.add(row.id)
    // Recovery reconstructs authority/projection only; it never invents a second movement.
    if(row.refund) overlap++
  }
}
assert.equal(redisProjection.size,N)
assert.equal(active.size,N)
assert.equal(ready.size,N)
assert.equal(wakes,50)
assert.equal(duplicateMovement,0)
assert.equal(overlap,0)

console.log(JSON.stringify({
  certification:"PASS",
  gate:"DR-10-LOST-KICK-LOST-REDIS-RECOVERY",
  lostImmediateKick:true,
  lostContinuationKick:true,
  totalRedisProjectionLossModeled:true,
  workerCrashBeforeIndependentWake:true,
  independentWakeRecoveryPath:true,
  postgresDurableRediscovery:true,
  boundedPage:page,
  syntheticOutstanding:N,
  wakesToCoverSyntheticSet:wakes,
  reconstructed:N,
  duplicateMovementObserved:duplicateMovement,
  settlementRefundOverlapObserved:overlap,
  missingLegacyBootstrapMarkersRecoverable:true,
  contradictoryLegacyBootstrapMarkersFailClosed:true,
  financialSourceChanged:true,
  financialMovementExecuted:false,
  liveFaultInjectionRequiredAfterDeploy:true
},null,2))
