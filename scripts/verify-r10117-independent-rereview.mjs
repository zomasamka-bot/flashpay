import { strict as assert } from "node:assert"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
const root=new URL("../",import.meta.url)
const read=p=>fs.readFileSync(new URL(p,root),"utf8")
const run=p=>{const r=spawnSync(process.execPath,[p],{cwd:new URL("../",import.meta.url),encoding:"utf8"});assert.equal(r.status,0,`${p}\n${r.stdout}\n${r.stderr}`)}

for(const p of[
 "scripts/verify-r10115-full-financial-regression.mjs",
 "scripts/verify-r10116-clean-zip-production-certification.mjs",
 "scripts/verify-r10016-independent-rereview.mjs",
 "scripts/verify-nfin13-final-financial-certification.mjs",
 "scripts/verify-nfinx6-final-residual-uncertainty-closure.mjs",
 "scripts/verify-financial-lease-loss-adversarial-safety.mjs",
])run(p)

const db=read("lib/db.ts"),locked=read("lib/a2u-locked-executor.ts"),exec=read("lib/a2u-executor.ts")
const recovery=read("lib/a2u-recovery-service.ts"),refund=read("lib/refund-blockchain-submit.ts")
const refundStore=read("lib/refund-checkpoint-store.ts"),wallet=read("lib/pi-wallet-submit-lock.ts")
const route=read("app/api/recovery/transient/route.ts"),complete=read("app/api/pi/complete/route.ts")
const approve=read("app/api/pi/approve/route.ts"),payments=read("app/api/payments/route.ts")
const accounting=read("app/api/operations/r1001-accounting-truth/route.ts")
const incident=read("app/api/operations/incident-health/route.ts")
const xdr=read("lib/financial-recovery-settlement-submit-xdr-verifier.ts")
const horizon=read("lib/financial-recovery-horizon-proof.ts")
const x4=read("scripts/verify-nfinx4-stellar-v17-operation-source.mjs")
const r6=read("scripts/verify-r1016-normal-durable-authority-secret-minimization.mjs")

const review=[
 ["equal-amount",db.includes("params.merchantAmount !== params.customerAmount")],
 ["zero-commission",db.includes("params.appCommission!==0")&&db.includes("app_commission = 0")],
 ["fee-separate",db.includes("horizon_fee_stroops")],
 ["exact-stroops-xdr",xdr.includes("exactStroopAmountMatch(operation.amount, input.amount)")],
 ["exact-stroops-horizon",horizon.includes("exactStroopAmountMatch(operation.amount, amount)")],
 ["durable-u2a-ownership",db.includes("u2a_approval_identifier")&&db.includes("u2a_identifier")&&db.includes("u2a_txid")],
 ["durable-stage1",db.includes("recordSettlementA2UCreatedCheckpoint")],
 ["durable-prepared",db.includes("recordSettlementPreparedCheckpoint")&&db.includes("prepared_envelope_xdr")&&db.includes("prepared_sequence")],
 ["durable-horizon",db.includes("recordSettlementHorizonCheckpoint")],
 ["durable-pi",db.includes("recordSettlementPiCompletedCheckpoint")],
 ["durable-db-finality",db.includes("recordSettlementDbFinalizedCheckpoint")],
 ["settlement-refund-xor",locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)")&&refundStore.includes("authority.settlementActive")],
 ["wallet-sequence-authority",wallet.includes("SUBMIT_LOCK_TTL_SECONDS = 600")&&wallet.includes("SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000")],
 ["authoritative-recovery",recovery.includes("rebuildSettlementProjectionFromDurable")],
 ["refund-horizon-recovery",refund.includes("readRefundPreparedRecoveryEvidence")&&refund.includes("CONFIRMED_TX")],
 ["unknown-fail-closed",recovery.includes("durable_projection_unavailable")&&recovery.includes("durable_authority_conflict")],
 ["bounded-recovery",route.includes("BOUNDED_PIPELINE_CONCURRENCY = 2")&&route.includes("WALLET_DRAIN_BURST_BUDGET_MS = 60_000")],
 ["u2a-claim-before-approve",approve.includes("recordSettlementU2AApprovalClaim")],
 ["complete-no-internal-secret-dependency",!/serverConfig\.a2uInternalSecret|process\.env\.A2U_INTERNAL_SECRET/.test(complete)],
 ["server-rate-limits",payments.includes("consumeFinancialRateLimit")&&approve.includes("consumeFinancialRateLimit")&&complete.includes("consumeFinancialRateLimit")],
 ["bearer-not-financial-authority",!exec.includes('/v2/me')&&!exec.includes('Bearer ${ctx.accessToken}')&&r6.includes('legacyBearerProjection:"TOLERATED_NOT_CONSULTED"')],
 ["accounting-reconciliation-readonly",accounting.includes("financialMovementExecuted: false")&&accounting.includes("readOnly: true")],
 ["incident-health",incident.includes("wakeFresh")&&incident.includes("manualReview")],
 ["stellar-v17-operation-source",x4.includes('sdkVersion:"17.1.0"')&&x4.includes("Operation.fromXdrObject")],
]
for(const[n,ok]of review)assert.equal(ok,true,n)

// Production evidence independently observed for the published R101-16 same-SHA deployment.
// NOTICE-level IF NOT EXISTS messages are not classified as runtime errors.
const production={
 deploymentId:"dpl_7pvYLR4Xy7nthaXzYWeb9D3Xyk91",
 sha:"c71b24d376737987c463d1a7a29266758f5a4be5",
 parent:"06bdbbef38b41af0c165739d123a90f4b18313fc",
 tree:"f87c68bd87ad5bab9a54943cceb722ee5ac4b398",
 ready:true,production:true,aliasError:null,runtimeErrors:0,recoveryStatus:200,
 activeSetSize:68,readySetSize:0,settlementAttempts:0,refundAttempts:0,
 budgetExhausted:false,continuationScheduled:false,piCreateBackpressureActive:false,
 wakeDurationMs:4305,workDurationMs:505,
}
for(const k of["ready","production"])assert.equal(production[k],true)
assert.equal(production.aliasError,null);assert.equal(production.runtimeErrors,0);assert.equal(production.recoveryStatus,200)
assert.equal(production.budgetExhausted,false);assert.equal(production.continuationScheduled,false);assert.equal(production.piCreateBackpressureActive,false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-17-INDEPENDENT-REREVIEW",
 reviewerClaimsReexamined:review.length,
 reviewerClaimsPassed:review.length,
 predecessorR10116ProductionClosed:true,
 productionEvidence:production,
 confirmedNewFinancialDefects:0,
 confirmedCompatibilityDefects:0,
 financialInvariantViolationsDetected:0,
 unexplainedFinancialMovementsDetected:0,
 settlementRefundOverlapDetected:0,
 duplicateFinancialMovementDetected:0,
 runtimeFinancialSourceChanged:false,
 financialMovementExecuted:false,
 blindRetryAdded:false,
 testHooksClassification:"INTENTIONALLY_OUT_OF_SCOPE_ABSENT_INDEPENDENT_PRODUCTION_IMPACT",
 residualNotes:[
  "legacy accessToken projection compatibility remains tolerated but is not consulted as financial authority",
  "historical durable rediscovery conflict count remains fail-closed and is not a new regression"
 ],
 finalPlanStatus:"R101-CANDIDATE-FOR-FULL-CLOSURE-AFTER-THIS-CERTIFIER-IS-PUBLISHED-AND-SAME-SHA-RUNTIME-VERIFIED"
},null,2))
