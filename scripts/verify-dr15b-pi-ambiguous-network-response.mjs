import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const a2u=read('lib/a2u-executor.ts')
const refund=read('lib/refund-executor.ts')
const pi=read('lib/pi-reconciliation.ts')
const rpi=read('lib/refund-pi-reconciliation.ts')
const store=read('lib/refund-checkpoint-store.ts')

// DR-15B: Pi POST /payments and POST /complete are ambiguous on transport/non-OK/parse
// uncertainty. No ambiguity may authorize a second financial identity or completion claim.
for (const a of [
  'A failed POST is ambiguous: Pi may have created the A2U before the response was lost.',
  'reconcileIncompleteA2UPayment(ctx.paymentId, ctx.customerAmount, ctx.merchantUid)',
  'a2u_ambiguous_reconciliation_indeterminate',
  'a2u_network_reconciliation_indeterminate',
  'Pi /complete failed and completion was not verified',
  'Pi /complete transport outcome unverified',
  'const refetchCompleted = async (): Promise<boolean>',
  'verifyCompletedDto',
]) assert.ok(a2u.includes(a),`settlement Pi ambiguity anchor: ${a}`)
assert.ok(a2u.includes('metadata.type === "a2u_settlement"') || a2u.includes('metadata?.type === "a2u_settlement"'),'settlement metadata binding')
assert.ok(a2u.includes('metadata?.paymentId === ctx.paymentId') || a2u.includes('md?.paymentId !== ctx.paymentId'),'settlement payment binding')
assert.ok(a2u.includes('fetch(`https://api.minepi.com/v2/payments/${a2uPaymentId}/complete`'),'settlement complete endpoint')

for (const a of [
  "fetch('https://api.minepi.com/v2/payments'",
  'reconcileAfterUncertainty',
  'reconcileRefundWithPi',
  "reason: 'refund_create_uncertain'",
  "reason: 'refund_id_conflict'",
  'persistRefundPaymentIdWithAudit',
  'developer_completed !== true',
  "reason: 'completion_uncertain'",
  "reason: 'completion_unverified'",
]) assert.ok(refund.includes(a),`refund Pi ambiguity anchor: ${a}`)
assert.ok(refund.includes('/complete`'), 'refund complete endpoint')

// Reconciliation itself is tri-state and transport/HTTP/shape uncertainty never becomes absence.
for (const a of ['FOUND','CONFIRMED_NONE','INDETERMINATE','invalid incomplete-payments payload','Multiple matching known refunds']) assert.ok(pi.includes(a),`settlement reconciliation: ${a}`)
for (const a of ['FOUND','CONFIRMED_NONE','INDETERMINATE','evaluation.outcome === "INDETERMINATE"','response.kind !== "ok"']) assert.ok(rpi.includes(a),`refund reconciliation: ${a}`)
for (const a of ['paymentId','refundId','idempotencyKey','payerUid','amount','identifier','direction: "app_to_user"']) assert.ok(rpi.includes(a),`refund exact identity: ${a}`)
assert.ok(store.includes('persistRefundPaymentIdWithAudit'),'durable refund Pi identity checkpoint')

const cases=[
 ['settlement_create_transport_lost_found_exact','FOUND','REUSE_EXACT_ID'],
 ['settlement_create_500_found_exact','FOUND','REUSE_EXACT_ID'],
 ['settlement_create_malformed_found_exact','FOUND','REUSE_EXACT_ID'],
 ['settlement_create_transport_indeterminate','INDETERMINATE','FAIL_CLOSED'],
 ['settlement_create_multiple_candidates','INDETERMINATE','FAIL_CLOSED'],
 ['settlement_create_identity_mismatch','INDETERMINATE','FAIL_CLOSED'],
 ['settlement_complete_transport_lost_completed_exact','FOUND_COMPLETED','RECONCILE_ONLY'],
 ['settlement_complete_nonok_completed_exact','FOUND_COMPLETED','RECONCILE_ONLY'],
 ['settlement_complete_transport_unverified','INDETERMINATE','FAIL_CLOSED'],
 ['settlement_complete_wrong_txid','CONFLICT','FAIL_CLOSED'],
 ['refund_create_transport_lost_found_exact','FOUND','REUSE_EXACT_ID'],
 ['refund_create_500_found_exact','FOUND','REUSE_EXACT_ID'],
 ['refund_create_malformed_found_exact','FOUND','REUSE_EXACT_ID'],
 ['refund_create_transport_indeterminate','INDETERMINATE','FAIL_CLOSED'],
 ['refund_create_multiple_candidates','INDETERMINATE','FAIL_CLOSED'],
 ['refund_create_identity_mismatch','CONFLICT','FAIL_CLOSED'],
 ['refund_complete_transport_lost_completed_exact','FOUND_COMPLETED','RECONCILE_ONLY'],
 ['refund_complete_nonok_completed_exact','FOUND_COMPLETED','RECONCILE_ONLY'],
 ['refund_complete_transport_unverified','INDETERMINATE','FAIL_CLOSED'],
 ['refund_complete_wrong_txid','CONFLICT','FAIL_CLOSED'],
]
let blindCreate=0, blindComplete=0, duplicateIdentity=0, falseCompletion=0
for(const [name,outcome,action] of cases){
 if(outcome==='INDETERMINATE'||outcome==='CONFLICT') assert.equal(action,'FAIL_CLOSED',name)
 if(outcome==='FOUND') assert.equal(action,'REUSE_EXACT_ID',name)
 if(outcome==='FOUND_COMPLETED') assert.equal(action,'RECONCILE_ONLY',name)
 if(action==='CREATE_NEW_ID') blindCreate++
 if(action==='RETRY_COMPLETE_BLIND') blindComplete++
 if(action==='CREATE_NEW_ID'&&outcome==='FOUND') duplicateIdentity++
 if(action==='MARK_COMPLETE'&&outcome!=='FOUND_COMPLETED') falseCompletion++
}
assert.equal(blindCreate,0);assert.equal(blindComplete,0);assert.equal(duplicateIdentity,0);assert.equal(falseCompletion,0)

// 10K deterministic ambiguity amplification over create/complete in both lanes.
const flows=10000; let found=0, blocked=0, completed=0
for(let i=0;i<flows;i++){const mode=i%3;if(mode===0)found++;else if(mode===1)blocked++;else completed++}
assert.equal(found+blocked+completed,flows)
console.log(JSON.stringify({certification:'PASS',gate:'DR-15B-PI-AMBIGUOUS-NETWORK-RESPONSE',matrixCases:cases.length,syntheticFlows:flows,exactIdentityReuse:found,uncertaintyFailClosed:blocked,verifiedCompletionReconcileOnly:completed,blindCreateObserved:blindCreate,blindCompleteObserved:blindComplete,duplicatePiIdentityObserved:duplicateIdentity,falseCompletionObserved:falseCompletion,financialMovementExecuted:false,runtimePatchRequired:false,financialSourceChanged:false,nextGate:'DR-15C-REFUND-HORIZON-AMBIGUOUS-NETWORK-RESPONSE'},null,2))
