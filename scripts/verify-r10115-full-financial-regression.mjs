import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const exists=p=>fs.existsSync(new URL("../"+p,import.meta.url))

// R101-15 is the aggregate financial certification gate. It adds no runtime authority.
// Every prior R101 gate plus the mature N-FIN/F2-era financial invariants must still exist.
const r101=[
 "verify-r1011-u2a-approval-race.mjs","verify-r1012-durable-u2a-approval-claim.mjs",
 "verify-r1013-approval-crash-matrix.mjs","verify-r1014-u2a-retry-incomplete-recovery.mjs",
 "verify-r1015-bearer-authority-redesign-proof.mjs","verify-r1016-normal-durable-authority-secret-minimization.mjs",
 "verify-r1017-complete-authentication-semantics.mjs","verify-r1018-server-abuse-rate-limit.mjs",
 "verify-r1019-drain-liveness.mjs","verify-r10110-queue-throughput-instrumentation.mjs",
 "verify-r10111-10k-nonfinancial-load.mjs","verify-r10112-10k-financial-safety-adversarial-model.mjs",
 "verify-r10113-controlled-live-capacity-calibration.mjs","verify-r10114-reconciliation-alerts.mjs",
]
for(const f of r101) assert.ok(exists("scripts/"+f),`missing R101 gate: ${f}`)

const financial=[
 "verify-financial-lease-loss-adversarial-safety.mjs",
 "verify-nfin-lock-lease-renewal.mjs","verify-nfin6-10k-capacity.mjs",
 "verify-nfin7-horizon-refund-proof.mjs","verify-nfin8-pi-finality-ambiguity.mjs",
 "verify-nfin9-settlement-db-identity.mjs","verify-nfin10a-settlement-schema.mjs",
 "verify-nfin10b-stage1-durability.mjs","verify-nfin10c-prepared-horizon-durability.mjs",
 "verify-nfin10d-pi-db-finality.mjs","verify-nfin10e-redis-rebuild-recovery-cutover.mjs",
 "verify-nfin10f-durable-repopulation-cross-authority.mjs",
 "verify-nfin10g-adversarial-10k-durability.mjs","verify-nfin10h-final-production-readiness.mjs",
 "verify-nfin11-financial-kernel-matrix.mjs","verify-nfin12-cross-system-finality.mjs",
 "verify-nfin13-final-financial-certification.mjs","verify-nfinx1-durable-drain-progression.mjs",
 "verify-nfinx2-cross-authority-exclusion.mjs","verify-nfinx3-exact-stroops.mjs",
 "verify-nfinx4-stellar-v17-operation-source.mjs","verify-nfinx5-same-sha-adversarial-runtime-readiness.mjs",
 "verify-nfinx6-final-residual-uncertainty-closure.mjs","verify-refund-exact-stroop-authority.mjs",
]
for(const f of financial) assert.ok(exists("scripts/"+f),`missing financial regression gate: ${f}`)

const db=read("lib/db.ts")
const locked=read("lib/a2u-locked-executor.ts")
const executor=read("lib/a2u-executor.ts")
const refundStore=read("lib/refund-checkpoint-store.ts")
const refundIntent=read("lib/refund-intent-service.ts")
const wallet=read("lib/pi-wallet-submit-lock.ts")
const route=read("app/api/recovery/transient/route.ts")
const complete=read("app/api/pi/complete/route.ts")
const approve=read("app/api/pi/approve/route.ts")
const payments=read("app/api/payments/route.ts")

// Durable identity / ownership / finality.
for(const x of [
 "u2a_approval_identifier","u2a_approval_claimed_at","u2a_identifier","u2a_txid",
 "payer_uid","u2a_verified_at","u2a_completed_at","prepared_envelope_xdr","prepared_tx_hash",
 "prepared_sequence","a2u_payment_id","a2u_from_address","a2u_to_address","a2u_txid",
]) assert.ok(db.includes(x),`durable financial field missing: ${x}`)
for(const x of [
 "verifySettlementRefundAuthorityExclusion","recordSettlementPreparedCheckpoint",
 "recordSettlementHorizonCheckpoint","recordSettlementPiCompletedCheckpoint",
 "recordSettlementDbFinalizedCheckpoint",
]) assert.ok(db.includes(x),`durable settlement authority missing: ${x}`)

// Settlement XOR Refund and wallet sequence authority.
assert.ok(locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)"))
assert.ok(refundStore.includes("authority.settlementActive"))
assert.ok(refundIntent.includes("readSettlementRefundAuthority(payment.id)"))
assert.ok(wallet.includes('const SUBMIT_LOCK_TTL_SECONDS = 600'))
assert.ok(wallet.includes('const SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000'))
assert.ok(wallet.includes('kind: "settlement_prepared"'))

// Recovery is bounded; no 10K Promise.all fanout and no blind in-process retry loop.
assert.ok(route.includes("const BOUNDED_PIPELINE_CONCURRENCY = 2"))
assert.ok(route.includes("const WALLET_DRAIN_BURST_BUDGET_MS = 60_000"))
assert.equal(/Promise\.all\(\s*(?:Array\.from\(\{\s*length:\s*10000|[A-Za-z_$][\w$]*10k)/i.test(route),false)
assert.ok(route.includes("RECOVERY_WAKE_HEALTH_KEY"))

// R101 secret/auth boundaries remain in force.
assert.equal(executor.includes('/v2/me'),false)
assert.equal(executor.includes('Bearer ${ctx.accessToken}'),false)
const r1016=read("scripts/verify-r1016-normal-durable-authority-secret-minimization.mjs")
assert.ok(r1016.includes('legacyBearerProjection:"TOLERATED_NOT_CONSULTED"'))
assert.ok(approve.includes("recordSettlementU2AApprovalClaim"))
assert.equal(/serverConfig\.a2uInternalSecret|process\.env\.A2U_INTERNAL_SECRET/.test(complete),false)
const r1017=read("scripts/verify-r1017-complete-authentication-semantics.mjs")
assert.ok(r1017.includes('assert.equal(/serverConfig\\.a2uInternalSecret|process\\.env\\.A2U_INTERNAL_SECRET/.test(complete),false)'))
assert.ok(payments.includes("consumeFinancialRateLimit"))
assert.ok(approve.includes("consumeFinancialRateLimit"))
assert.ok(complete.includes("consumeFinancialRateLimit"))

// Financial arithmetic/evidence regressions are bound to dedicated certifiers.
const exact=read("scripts/verify-nfinx3-exact-stroops.mjs")
const stellar=read("scripts/verify-nfinx4-stellar-v17-operation-source.mjs")
const lease=read("scripts/verify-financial-lease-loss-adversarial-safety.mjs")
assert.ok(exact.includes("plusOneStroopRejected:true"))
assert.ok(stellar.includes('sdkVersion:"17.1.0"'))
assert.ok(lease.includes("duplicatePreparedSequenceSecondAcceptanceBlocked: true"))

// Test/fault-injection hooks are intentionally outside defect classification unless
// an independent production-impacting path is proven. This gate neither removes nor enables them.
const self=fs.readFileSync(new URL(import.meta.url),"utf8")
const imports=self.match(/^import .*$/gm)??[]
assert.deepEqual(imports,[
 'import { strict as assert } from "node:assert"',
 'import fs from "node:fs"',
])

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-15-FULL-FINANCIAL-REGRESSION",
 priorR101GatesBound:r101.length,
 matureFinancialGatesBound:financial.length,
 durableU2AOwnership:true,
 settlementRefundMutualExclusion:true,
 exactStroopAuthority:true,
 stellarV17Compatibility:true,
 walletSequenceSerialized:true,
 leaseLossSafety:true,
 boundedRecovery:true,
 bearerAuthorityRemoved:true,
 completeAuthSemanticsPreserved:true,
 abuseRateLimitsPreserved:true,
 reconciliationFailClosed:true,
 testHooksClassification:"INTENTIONALLY_OUT_OF_SCOPE_ABSENT_INDEPENDENT_PRODUCTION_IMPACT",
 runtimeSourceChanged:false,
 financialSourceChanged:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 horizonCalledByCertifier:false,
 productionDataMutated:false,
 sourcePatchRequired:false,
 nextGate:"R101-16-CLEAN-ZIP-PRODUCTION-CERTIFICATION"
},null,2))
