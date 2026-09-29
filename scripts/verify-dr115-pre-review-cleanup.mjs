import fs from 'node:fs'
import assert from 'node:assert/strict'
const read=(p)=>fs.readFileSync(p,'utf8')
const exists=(p)=>fs.existsSync(p)
const page=read('app/page.tsx')
const control=read('app/control-panel/page.tsx')
const payments=read('app/api/payments/route.ts')
const approve=read('app/api/pi/approve/route.ts')
const complete=read('app/api/pi/complete/route.ts')
const recovery=read('app/api/recovery/transient/route.ts')
const a2u=read('lib/a2u-executor.ts')
const refund=read('lib/refund-executor.ts')
const refundSubmit=read('lib/refund-blockchain-submit.ts')
const dr17=read('app/api/certification/dr17/run/route.ts')
const dr17Engine=read('lib/dr17-shared-certification.mjs')

// Reviewer-facing and activation surfaces removed.
for (const source of [page,control]) {
  assert.doesNotMatch(source,/\/api\/control\/dr1(?:0|1|4)/)
  assert.doesNotMatch(source,/\bDR1(?:0|1|4)\b/)
}
for (const p of ['app/api/control/dr10/route.ts','app/api/control/dr11/route.ts','app/api/control/dr14/route.ts','lib/dr14-live-crash-certification.ts','app/reset/page.tsx','app/api/reset/payments/route.ts','app/api/settlements/route.ts']) assert.equal(exists(p),false,p)

// Production amount-specific interruption branches removed.
for (const source of [a2u,complete]) {
  assert.doesNotMatch(source,/Stage1-only interruption 0\.14|Stage2 prepared checkpoint fault point 0\.11|Stage2 post-submit fault point 0\.12|Fresh dispatch interruption 0\.13/)
}
for (const source of [a2u,refund,refundSubmit]) assert.doesNotMatch(source,/consumeDr14Crash/)
assert.doesNotMatch(recovery,/FLASHPAY_DR10_TOTAL_REDIS_LOSS_TEST|dr10-total-redis-loss|dr10-keyspace-census/)
assert.doesNotMatch(payments,/certification:dr10:maintenance|certification:dr11:next-010|recordDr11RefundCertificationHold/)
assert.doesNotMatch(approve,/certification:dr11|readDr11RefundCertificationHold/)

// Historical durable DR11 safety remains fail-closed; no new arm producer exists.
assert.match(complete,/readDr11RefundCertificationHold/)
assert.match(recovery,/readDr11RefundCertificationHold/)
assert.match(complete,/DR11 durable hold authority unavailable/)
assert.match(recovery,/dr11_durable_hold_indeterminate/)

// Normal financial kernel anchors preserved.
assert.match(approve,/recordSettlementU2AApprovalClaimFromStartLease/)
assert.match(complete,/recordSettlementU2AVerifiedCheckpoint/)
assert.match(complete,/recordSettlementU2ACompletedCheckpoint/)
assert.match(a2u,/getSettlementCheckpointAuthoritative/)
assert.match(a2u,/acquirePiWalletIntentSubmitLock/)
assert.match(refund,/readSettlementRefundAuthority/)
assert.match(refund,/acquirePiWalletIntentSubmitLock/)

// DR17 evidence remains internal and untouched.
assert.match(dr17,/const RELEASE = "DR112"/)
assert.match(dr17Engine,/const N = 10_000/)
assert.match(dr17Engine,/assert\.equal\(recovered,N\)/)

// Non-production refund P7 hooks remain production-inert.
for (const source of [refund,refundSubmit]) {
  if (/P7 TEST/.test(source)) {
    assert.match(source,/VERCEL_ENV !== "production"/)
    assert.match(source,/FLASHPAY_REFUND_CRASH_TEST === "1"/)
  }
}
console.log(JSON.stringify({
 certification:'PASS',gate:'DR115-PRE-REVIEW-CERTIFICATION-SURFACE-CLEANUP',
 reviewerCertificationUiRemoved:true,dr10DestructiveActivationRemoved:true,
 dr11NewActivationRemoved:true,dr11HistoricalDurableSafetyPreserved:true,
 dr14CrashActivationRemoved:true,p7ProductionAmountHooksRemoved:true,
 dr17EvidencePreserved:true,financialKernelAnchorsPreserved:true
},null,2))
