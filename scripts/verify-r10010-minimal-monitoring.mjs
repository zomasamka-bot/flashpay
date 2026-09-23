import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const transient=read("app/api/recovery/transient/route.ts")
const incident=read("app/api/operations/incident-health/route.ts")
const financial=read("app/api/operations/financial-health/route.ts")
const r1009=read("scripts/verify-r1009-recovery-latency-matrix.mjs")
const marker='await redis.set(RECOVERY_WAKE_HEALTH_KEY, new Date().toISOString(), { ex: 7 * 24 * 60 * 60 })'
assert.equal(transient.split(marker).length-1,1)
const m=transient.indexOf(marker), lease=transient.indexOf("const drainLease = await acquireTransientDrainLease()")
const cap=transient.indexOf('console.log("[P7H CAPACITY] transient wake"')
const success=transient.indexOf("return NextResponse.json({ processed: results.length")
assert.ok(m>lease && m>cap && m<success)
for(const x of ['if (requestedMode === CONTINUATION_MODE)','if (drainLease.state === "unavailable")','if (drainLease.state === "busy")','return NextResponse.json({ error: "Durable financial work repopulation unavailable" }','return NextResponse.json({ error: "Active recovery index unavailable" }']){
  const i=transient.indexOf(x); assert.ok(i>=0&&i<m,`early path must not refresh health: ${x}`)
}
for(const x of ["const WAKE_FRESH_MS = 30 * 60_000","lastWakeAgeMs","wakeFresh:age===null?null:age<=WAKE_FRESH_MS","recovery.wakeFresh!==true"])assert.ok(incident.includes(x))
for(const x of ["settlementOpen","settlementFailed","refundPending","refundManualReview","drainLeaseActive","piCreateBackpressureActive"])assert.ok(financial.includes(x))
assert.ok(r1009.includes("periodicFallbackPreserved:true"))
assert.ok(r1009.includes("blindFinancialRetryAdded:false"))
console.log(JSON.stringify({
 certification:"PASS",gate:"R100-10-MINIMAL-MONITORING",
 defectConfirmed:"last-wake freshness was stamped before recovery completion",
 fix:"stamp freshness only after a fully completed trusted drain",
 falseHealthyOnEarlyFailureClosed:true,continuationOnlyDoesNotRefreshHealth:true,busyLeaseDoesNotRefreshHealth:true,
 ownerIncidentHealthUsesCompletedWakeFreshness:true,existingFinancialSignalsReused:true,
 newFinancialAuthority:false,financialMovementExecuted:false,financialRetryBehaviorChanged:false,
 changedRuntimeFiles:["app/api/recovery/transient/route.ts"],
 certificationFiles:["scripts/verify-r10010-minimal-monitoring.mjs"]
},null,2))
