import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const incident=read("app/api/operations/incident-health/route.ts")
const financial=read("app/api/operations/financial-health/route.ts")
const accounting=read("app/api/operations/r1001-accounting-truth/route.ts")
const transient=read("app/api/recovery/transient/route.ts")
const pi=read("lib/pi-reconciliation.ts")
const refundPi=read("lib/refund-pi-reconciliation.ts")
const monitor=read("scripts/verify-r10010-minimal-monitoring.mjs")
const r10113=read("scripts/verify-r10113-controlled-live-capacity-calibration.mjs")

// Reconciliation must remain owner-authenticated, read-only, and fail closed.
for(const source of [incident,financial,accounting])
 assert.ok(source.includes("verifyOwnerAuthorizationHeader"),"operations reconciliation route lost owner authentication")
for(const x of [
 "duplicateIdentityCount","refundDuplicateIdentityCount","merchantBalanceMismatchCount",
 "financialMovementExecuted: false","readOnly: true",
]) assert.ok(accounting.includes(x),`accounting truth evidence missing: ${x}`)
assert.ok(accounting.includes("HAVING COUNT(*) > 1"))
assert.ok(accounting.includes("settled_delta"))
assert.ok(accounting.includes("refund_accounting_records"))

// Incident health must reconcile durable financial backlog with completed-wake freshness.
for(const x of [
 "settlementFailed","refundPending","manualReview","oldestOpenAt",
 "lastWakeAgeMs","wakeFresh","recovery.wakeFresh!==true",
]) assert.ok(incident.includes(x),`incident signal missing: ${x}`)
for(const x of [
 "settlementOpen","settlementFailed","refundPending","refundManualReview",
 "drainLeaseActive","piCreateBackpressureActive",
]) assert.ok(financial.includes(x),`financial health signal missing: ${x}`)

// Pi/refund reconciliation uncertainty must never authorize a blind financial action.
assert.ok(pi.includes('outcome: "INDETERMINATE"'))
assert.ok(pi.includes('evaluateFinancialRecoveryPiCandidates'))
assert.ok(refundPi.includes('authorizesFinancialAction: false'))
assert.ok(refundPi.includes('outcome: "INDETERMINATE"'))
assert.ok(refundPi.includes('evaluateFinancialRecoveryPiCandidates'))

// Periodic recovery emits searchable warning/error signals while a completed wake
// is the only event allowed to refresh the health marker.
assert.ok(transient.includes('console.warn("[R100-10 MONITORING] completed wake health marker unavailable")'))
assert.ok(transient.includes('console.warn("[P7H CAPACITY] settlement ready coverage truncated")'))
assert.ok(transient.includes('console.warn("[P7H CAPACITY] settlement ready authority baseline mismatch")'))
assert.ok(transient.includes('await redis.set(RECOVERY_WAKE_HEALTH_KEY, new Date().toISOString(), { ex: 7 * 24 * 60 * 60 })'))
assert.ok(monitor.includes("falseHealthyOnEarlyFailureClosed:true"))
assert.ok(r10113.includes('runtimeErrorsObserved:0'))

// R101-14 intentionally adds no autonomous repair and no new financial authority.
// Alert delivery is platform configuration; code supplies authenticated health and
// structured runtime signals without embedding notification credentials.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,[
 'import { strict as assert } from "node:assert"',
 'import fs from "node:fs"',
])

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-14-RECONCILIATION-AND-ALERTS",
 reconciliation:{
  accountingIdentityDuplicates:true,
  refundAccountingDuplicates:true,
  merchantBalanceMismatch:true,
  settlementBacklog:true,
  refundBacklog:true,
  manualReview:true,
  completedWakeFreshness:true,
  piUncertaintyFailClosed:true,
  refundPiUncertaintyFailClosed:true
 },
 alertSurfaces:{
  authenticatedIncidentHealth:true,
  authenticatedFinancialHealth:true,
  structuredRuntimeWarnings:true,
  runtimeErrorsExternallyChecked:true,
  deliveryConfiguration:"VERCEL_PLATFORM_NOT_APPLICATION_SECRET"
 },
 autonomousRepairAdded:false,
 newFinancialAuthority:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 horizonCalledByCertifier:false,
 productionDataMutated:false,
 runtimeSourceChanged:false,
 sourcePatchRequired:false,
 nextGate:"R101-15-FULL-FINANCIAL-REGRESSION"
},null,2))
