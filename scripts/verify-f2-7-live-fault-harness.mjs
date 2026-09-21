import assert from 'node:assert/strict'
import fs from 'node:fs'

const read=(p)=>fs.readFileSync(p,'utf8')
const helper=read('lib/f2-7-fault-injection.ts')
const transient=read('app/api/recovery/transient/route.ts')
const complete=read('app/api/pi/complete/route.ts')
const recovery=read('app/api/recovery/transient/route.ts')
const a2u=read('lib/a2u-executor.ts')
const refund=read('lib/refund-executor.ts')
const refundSubmit=read('lib/refund-blockchain-submit.ts')
const db=read('lib/db.ts')
const locked=read('lib/a2u-locked-executor.ts')
const refundAuto=read('lib/refund-auto-orchestrator.ts')
const refundCheckpoint=read('lib/refund-checkpoint-store.ts')

const settlementPoints=[
'u2a_verified_before_pi_complete','pi_complete_before_u2a_completed','u2a_completed_before_redis_projection',
'a2u_created_before_local_checkpoint','a2u_checkpoint_before_prepared','prepared_before_horizon_submit',
'horizon_success_before_durable_checkpoint','horizon_checkpoint_before_pi_complete','pi_complete_before_durable_checkpoint',
'durable_pi_before_db','db_commit_before_durable_finality','db_finality_before_redis_final']
const refundPoints=[
'refund_intent_before_pi_create','refund_pi_create_before_id_checkpoint','refund_prepared_before_horizon_submit',
'refund_horizon_success_before_tx_checkpoint','refund_tx_checkpoint_before_pi_complete','refund_pi_complete_before_payment_checkpoint',
'refund_payment_checkpoint_before_accounting','refund_accounting_before_audit','refund_audit_before_completion','refund_completion_before_redis_final']
assert.equal(new Set([...settlementPoints,...refundPoints]).size,22)
for(const p of settlementPoints) assert.ok(helper.includes(`"${p}"`),`helper settlement point ${p}`)
for(const p of refundPoints) assert.ok(helper.includes(`"${p}"`),`helper refund point ${p}`)
assert.ok(helper.includes('F27_CERT_MERCHANT_ID = "hazemaboria"'))
assert.ok(helper.includes('F27_CERT_MERCHANT_UID = "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"'))
assert.ok(helper.includes('F27_SETTLEMENT_AMOUNT = 0.16'))
assert.ok(helper.includes('F27_REFUND_AMOUNT = 0.1'))
for(const forbidden of ['fetch(', 'submitTransaction(', 'recordA2UTransactionAtomic(', 'recordRefundAccounting(', 'query(']) assert.equal(helper.includes(forbidden),false,`injector side effect ${forbidden}`)

for(const p of settlementPoints.slice(0,3)){assert.ok(complete.includes(p),`complete hook ${p}`);assert.ok(recovery.includes(p),`recovery hook ${p}`)}
for(const p of settlementPoints.slice(3)) assert.ok(a2u.includes(p),`a2u hook ${p}`)
for(const p of ['refund_intent_before_pi_create','refund_pi_create_before_id_checkpoint','refund_tx_checkpoint_before_pi_complete','refund_pi_complete_before_payment_checkpoint','refund_payment_checkpoint_before_accounting','refund_accounting_before_audit','refund_audit_before_completion','refund_completion_before_redis_final']) assert.ok(refund.includes(p),`refund hook ${p}`)
for(const p of ['refund_prepared_before_horizon_submit','refund_horizon_success_before_tx_checkpoint']) assert.ok(refundSubmit.includes(p),`refund submit hook ${p}`)

assert.ok(recovery.includes("method:'POST'"))
assert.ok(recovery.includes('/complete`'))
assert.ok(recovery.includes("body:JSON.stringify({txid:ingress.u2aTxid})"))
assert.ok(recovery.includes('transaction.verified!==true'))
assert.ok(recovery.includes("pi.status.developer_completed!==true"))
assert.ok(recovery.includes("dbDone=d.stage==='db_finalized'"))
assert.ok(recovery.includes("status:dbDone?'settled_to_merchant'"))
assert.ok(db.includes("stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')"))
assert.ok(locked.includes('async function verifyStage1OnlyDurableAuthority'))
assert.ok(locked.includes('durable.checkpoint.stage !== "a2u_created"'))
assert.ok(locked.includes('Settlement Stage1 durable authority could not be verified'))
assert.ok(locked.includes('[F2-7 STAGE1 DURABLE RESUME]'))
const stage1Fn=locked.slice(locked.indexOf('export function isStage1OnlySettlementDispatchCandidate'),locked.indexOf('async function verifyStage1OnlyDurableAuthority'))
assert.equal(stage1Fn.includes('isSettlementReconcileCandidate('),false)
assert.ok(stage1Fn.includes('payment.a2uPaymentId'))
assert.ok(stage1Fn.includes('payment.a2uPreparedTxHash === undefined'))
assert.ok(a2u.includes('[F2-7 SAME-SHA REDIS LOSS] settlement terminal projection deleted'))
assert.ok(refund.includes('[F2-7 SAME-SHA REDIS LOSS] refund terminal projection deleted'))
assert.equal(recovery.includes('F2_6_CAS_RUNTIME_CERT_ONCE_KEY'),false)
assert.equal(recovery.includes('[F2-6 CAS RUNTIME CERT]'),false)


assert.equal(a2u.includes('[F2-7 DURABLE PI RESUME]'),true,'durable Pi resume marker')
assert.equal(a2u.includes('const durablePiReplay = await recordSettlementPiCompletedCheckpoint'),true,'already-completed Pi durable replay')
assert.equal(a2u.includes('recoveredAlreadyCompleted: true'),true,'durable Pi replay fault coverage')
assert.equal(a2u.includes('ensureRecoveredHorizonDurability'),true,'recovered Horizon durability helper')
assert.equal(a2u.includes('[F2-7 DURABLE HORIZON RESUME]'),true,'durable Horizon resume marker')
assert.equal(a2u.includes('recordSettlementHorizonCheckpoint({'),true,'durable Horizon replay/record')
assert.equal(a2u.includes('.transactions().transaction(a2uTxid).call()'),true,'Horizon GET proof for prepared-stage recovery')
assert.equal(a2u.includes('record.successful !== true'),true,'Horizon success proof')
assert.equal(refundAuto.includes('\"f2_7_interruption\"'),true,'F2-7 interruption uses short retry')
assert.equal(refundCheckpoint.includes("last_error_code='automatic_refund_blocked'"),true,'legacy F2-7 deferral error-code fence')
assert.equal(refundCheckpoint.includes("last_error_message='f2_7_interruption'"),true,'legacy F2-7 deferral marker fence')
assert.equal(refundCheckpoint.includes("updated_at<=NOW()-INTERVAL '60 seconds'"),true,'legacy F2-7 deferral minimum age')

assert.equal(refundCheckpoint.includes("export async function logF27RefundCheckpointDiagnostic"),true,'F2-7 refund diagnostic is explicit read-only helper')
assert.equal(refundCheckpoint.includes("WHERE refund_id=$1 OR payment_id=$2"),true,'F2-7 refund diagnostic targets exact existing identities')
assert.equal(refundCheckpoint.includes("[F2-7 REFUND CHECKPOINT DIAGNOSTIC]"),true,'F2-7 refund diagnostic marker')
assert.equal(transient.includes('logF27RefundCheckpointDiagnostic("db04df04-0297-4242-9bbd-cd25cd7c40c6", "5cbfd33b-3eb7-474d-afaa-7f4711919bdd")'),true,'F2-7 refund diagnostic targets certification refund only')
console.log(JSON.stringify({
  certification:'PASS',
  gate:'F2-7-LIVE-FAULT-HARNESS-CODE-READINESS',
  settlementFaultPoints:settlementPoints.length,
  refundFaultPoints:refundPoints.length,
  totalFaultPoints:settlementPoints.length+refundPoints.length,
  settlementTestAmount:0.16,
  refundTestAmount:0.1,
  liveExecutionRequiredAfterDeploy:true,
  injectorExternalFinancialSideEffects:0,
  f26TemporaryHookRemoved:true,
  terminalDbFinalizedRediscovery:true,
  u2aServerCompletionRecovery:true,
  stage1OnlyDurableResume:true,
  durableHorizonResume:true,
  refundFaultShortRetry:true,
  refundFaultLegacyDeferralCompatibility:true
},null,2))
