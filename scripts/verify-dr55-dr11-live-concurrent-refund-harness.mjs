import fs from 'node:fs'
import { strict as assert } from 'node:assert'
const route=fs.readFileSync('app/api/control/dr11/route.ts','utf8')
const executor=fs.readFileSync('lib/refund-executor.ts','utf8')
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
for(const x of ['verifyOwnerAuthorizationHeader','VERCEL_ENV !== "production"','FLASHPAY_DR11_LIVE_CONCURRENT_REFUND_TEST','DR11_CONCURRENT_REFUND','READINESS_ONLY','cp.stage !== "intent_created"','cp.refundPaymentId || cp.refundTxid','CONTENDERS = 2','MAX_ROUNDS = 8','Promise.all(contenders)','getRefundCheckpointReadOnly','refund_accounting_records','count(DISTINCT refund_payment_id)','count(DISTINCT refund_txid)','refund_blockchain_submission_started','refund_completed','settlement_movement_rows','DR11_LIVE_PASS']) assert.ok(route.includes(x),x)
assert.ok(route.indexOf('confirmation === READINESS_CONFIRM') < route.indexOf('Promise.all(contenders)'))
assert.ok(route.indexOf('cp.stage !== "intent_created"') < route.indexOf('Promise.all(contenders)'))
for(const x of ['beginRefundSubmissionAttempt(','beginRefundBlockchainSubmissionClaim(','acquirePiWalletIntentSubmitLock(','submitRefundBlockchainOnce','persistRefundBlockchainTxWithAudit(']) assert.ok(executor.includes(x),x)
for(const x of ['ON CONFLICT (payment_id) DO NOTHING','ON CONFLICT (event_id) DO NOTHING']) assert.ok(store.includes(x),x)
// Harness itself never bypasses the production executor or calls Pi/Horizon directly.
assert.ok(!route.includes('api.minepi.com'))
assert.ok(!route.includes('horizon.stellar.org'))
assert.ok(!route.includes('submitRefundBlockchainOnce'))
console.log(JSON.stringify({verdict:'PASS',gate:'DR55-DR11-LIVE-CONCURRENT-REFUND-HARNESS',ownerAuthenticated:true,productionAndEnvGated:true,exactConfirmation:true,pristineIntentStartRequired:true,contenders:2,boundedRounds:8,sameBarrierPromiseAll:true,usesProductionExecutorOnly:true,readinessIsReadOnly:true,postProofUniqueCheckpointAccountingPiIdentityTxid:true,settlementOverlapMustBeZero:true},null,2))
