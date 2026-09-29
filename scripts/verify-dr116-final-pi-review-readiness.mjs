import fs from 'node:fs'
import assert from 'node:assert/strict'
const read=(p)=>fs.readFileSync(p,'utf8')
const absent=(p)=>assert.equal(fs.existsSync(p),false,p)
const layout=read('app/layout.tsx')
const loader=read('components/pi-sdk-loader.tsx')
const sdk=read('lib/pi-sdk.ts')
const pay=read('app/pay/[id]/payment-content-with-id.tsx')
const payPage=read('app/pay/[id]/page.tsx')
const home=read('app/page.tsx')
const payments=read('app/api/payments/route.ts')
const approve=read('app/api/pi/approve/route.ts')
const complete=read('app/api/pi/complete/route.ts')
const recovery=read('app/api/recovery/transient/route.ts')

// Closed certification and orphaned legacy executable surfaces are absent.
for (const p of [
 'app/api/certification/dr17/run/route.ts','lib/dr17-shared-certification.mjs','lib/dr17-shared-certification.d.mts',
 'components/payment-reset-panel.tsx','components/merchant-settlements-view.tsx','lib/use-settlements.ts',
 'app/reset/page.tsx','app/api/reset/payments/route.ts','app/api/settlements/route.ts',
 'app/api/control/dr10/route.ts','app/api/control/dr11/route.ts','app/api/control/dr14/route.ts'
]) absent(p)
for (const source of [home,pay,loader]) assert.doesNotMatch(source,/\/api\/control\/dr1(?:0|1|4)|\/reset/)
assert.doesNotMatch(pay,/addDiagnostic|setDiagnostics|\[diagnostics/)
assert.doesNotMatch(payPage,/PaymentPageWithId.*Route params/)

// Pi official production handshake anchors.
assert.match(loader,/https:\/\/sdk\.minepi\.com\/pi-sdk\.js/)
assert.match(sdk,/Pi\.init\(\{ version: "2\.0", sandbox: false \}\)/)
assert.match(sdk,/Pi\.authenticate\(/)
assert.match(sdk,/"username"/)
assert.match(sdk,/"payments"/)
assert.match(sdk,/onIncompletePaymentFound/)
assert.match(sdk,/Pi\.createPayment/)
assert.match(sdk,/onReadyForServerApproval/)
assert.match(sdk,/\/api\/pi\/approve/)
assert.match(sdk,/onReadyForServerCompletion/)
assert.match(sdk,/\/api\/pi\/complete/)
assert.match(pay,/\/api\/pi\/start/)
assert.match(pay,/executePayment\(/)

// Server-side ownership/payment/finality/recovery anchors remain.
assert.match(payments,/recordSettlementPaymentIdentityCheckpoint/)
assert.match(approve,/recordSettlementU2AApprovalClaimFromStartLease/)
assert.match(complete,/recordSettlementU2AVerifiedCheckpoint/)
assert.match(complete,/recordSettlementU2ACompletedCheckpoint/)
assert.match(complete,/buildA2USuccessResponse/)
assert.match(recovery,/repopulateDurableU2AIngressWork/)
assert.match(recovery,/repopulateDurableSettlementWork/)
assert.match(recovery,/settlementAttempts/)
assert.match(recovery,/runAutomaticRefundPass/)

// No DR115 production interruption/activation regressions.
for (const source of [home,pay,payments,approve,complete,recovery]) {
 assert.doesNotMatch(source,/Stage1-only interruption 0\.14|Stage2 prepared checkpoint fault point 0\.11|Stage2 post-submit fault point 0\.12|Fresh dispatch interruption 0\.13/)
 assert.doesNotMatch(source,/flashpay:certification:dr10:maintenance:v1|flashpay:certification:dr11:next-010:v1/)
}
console.log(JSON.stringify({
 certification:'PASS',gate:'DR116-FINAL-PI-REVIEW-READINESS',
 closedCertificationEndpointRemoved:true,orphanLegacyUiRemoved:true,
 hiddenPaymentDiagnosticStateRemoved:true,piSdkLoaded:true,productionSandboxFalse:true,
 authenticatePaymentsScope:true,incompletePaymentHandler:true,
 approvalCallbackBound:true,completionCallbackBound:true,
 durableStartAuthority:true,financialKernelAnchorsPreserved:true,recoveryAnchorsPreserved:true
},null,2))
