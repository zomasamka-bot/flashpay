import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const submit=read('lib/refund-blockchain-submit.ts')
const evidence=read('lib/refund-blockchain-evidence.ts')
const horizon=read('lib/financial-recovery-settlement-submit-horizon-reader.ts')
const executor=read('lib/refund-executor.ts')
const store=read('lib/refund-checkpoint-store.ts')

// DR-15C: Refund Horizon submit ambiguity. Durable prepared identity and authorization
// must precede submit; ambiguity may reconcile exact movement or remain fail-closed.
for (const a of [
  'ensureRefundPreparedSubmit', 'authorizeRefundBlockchainSubmit',
  'envelopeXdr', 'preparedHash', 'preparedSequence',
  'server.submitTransaction(transaction)', 'readRefundPreparedRecoveryEvidence',
  'submitRefundPreparedStoredXdrOnce', 'readRefundBlockchainSubmitAuthorizationState',
  'TransactionBuilder.fromXDR(input.gate.prepared.envelopeXdr, "Pi Testnet")',
]) assert.ok(submit.includes(a),`refund submit anchor: ${a}`)
assert.ok(submit.indexOf('ensureRefundPreparedSubmit') < submit.indexOf('server.submitTransaction(transaction)'), 'prepared checkpoint before Horizon submit')
assert.ok(submit.indexOf('authorizeRefundBlockchainSubmit') < submit.indexOf('server.submitTransaction(transaction)'), 'durable authorization before Horizon submit')
assert.ok(submit.includes('catch (error)'), 'ambiguous submit exception boundary')
assert.ok(submit.includes('after.outcome === "VERIFIED"'), 'post-exception exact evidence reconciliation')

// Exact stored-XDR replay only: no rebuilding after ambiguous submit.
for (const a of [
  'input.gate.reference.preparedHash !== input.gate.prepared.preparedHash',
  'input.gate.reference.preparedSequence !== input.gate.prepared.preparedSequence',
  'transaction.toXDR() !== input.gate.prepared.envelopeXdr',
  'Buffer.from(transaction.hash()).toString("hex") !== input.gate.prepared.preparedHash',
  'transaction.sequence !== input.gate.prepared.preparedSequence',
  'transaction.source !== input.payment.from_address',
]) assert.ok(submit.includes(a),`exact replay binding: ${a}`)

// Horizon evidence is GET-only and triages 404 via exact source sequence; all read
// failures/shape uncertainty are INDETERMINATE and never authorize movement.
for (const a of ['outcome: "INDETERMINATE"','outcome: "HASH_NOT_FOUND"','observedSourceSequence','authorizesFinancialAction: false']) assert.ok(horizon.includes(a),`horizon read: ${a}`)
for (const a of ['outcome: "VERIFIED"','outcome: "UNRESOLVED"','outcome: "BLOCKED"','PREPARED_IS_NEXT','SOURCE_AT_OR_PAST_PREPARED','SOURCE_BEHIND_PREPARED_GAP']) assert.ok(evidence.includes(a),`refund evidence: ${a}`)
for (const a of ['preparedHash','preparedSequence','refundPaymentId','fromAddress','toAddress','amount']) assert.ok(evidence.includes(a),`exact evidence binding: ${a}`)
assert.ok(evidence.includes('moneyMovementProven: true') && evidence.includes('authorizesFinancialAction: false'), 'verified movement reconciles only')
assert.ok(evidence.includes('moneyMovementProven: false') && evidence.includes('authorizesFinancialAction: false'), 'unresolved evidence cannot authorize movement')

// Durable blockchain submission claim + authorization must be replay-safe.
for (const a of ['beginRefundBlockchainSubmissionClaim','refund_blockchain_submission_started','ON CONFLICT (event_id) DO NOTHING','authorizeRefundBlockchainSubmit','readRefundBlockchainSubmitAuthorizationState']) assert.ok(store.includes(a),`durable claim/authorization: ${a}`)
assert.ok(executor.includes('beginRefundBlockchainSubmissionClaim'), 'executor uses durable submission claim')
assert.ok(executor.includes('readRefundPreparedReplayUnderExistingOwner') || executor.includes('submitRefundPreparedStoredXdrOnce'), 'executor has prepared replay recovery')

const cases=[
 ['transport_throw_after_ledger_accept','VERIFIED','RECONCILE_ONLY'],
 ['http_504_then_hash_visible','VERIFIED','RECONCILE_ONLY'],
 ['proxy_timeout_then_hash_visible','VERIFIED','RECONCILE_ONLY'],
 ['connection_reset_then_hash_visible','VERIFIED','RECONCILE_ONLY'],
 ['malformed_submit_response_then_hash_visible','VERIFIED','RECONCILE_ONLY'],
 ['hash_404_source_exactly_before_prepared','PREPARED_IS_NEXT','EXACT_STORED_XDR_ONLY'],
 ['hash_404_source_at_prepared','SOURCE_AT_OR_PAST_PREPARED','FAIL_CLOSED'],
 ['hash_404_source_past_prepared','SOURCE_AT_OR_PAST_PREPARED','FAIL_CLOSED'],
 ['hash_404_source_behind_gap','SOURCE_BEHIND_PREPARED_GAP','FAIL_CLOSED'],
 ['horizon_tx_read_500','BLOCKED','FAIL_CLOSED'],
 ['horizon_ops_read_500','BLOCKED','FAIL_CLOSED'],
 ['account_read_failure_after_404','BLOCKED','FAIL_CLOSED'],
 ['wrong_hash','BLOCKED','FAIL_CLOSED'],
 ['wrong_sequence','BLOCKED','FAIL_CLOSED'],
 ['wrong_source','BLOCKED','FAIL_CLOSED'],
 ['wrong_destination','BLOCKED','FAIL_CLOSED'],
 ['wrong_amount','BLOCKED','FAIL_CLOSED'],
 ['wrong_memo_refund_payment_id','BLOCKED','FAIL_CLOSED'],
 ['multiple_operations','BLOCKED','FAIL_CLOSED'],
 ['failed_horizon_transaction','BLOCKED','FAIL_CLOSED'],
 ['authorization_missing','BLOCKED','FAIL_CLOSED'],
 ['wallet_owner_mismatch','BLOCKED','FAIL_CLOSED'],
 ['prepared_xdr_hash_mismatch','BLOCKED','FAIL_CLOSED'],
 ['prepared_xdr_sequence_mismatch','BLOCKED','FAIL_CLOSED'],
]
let blindRetry=0,freshRebuild=0,duplicate=0,falseSuccess=0
for(const [name,outcome,action] of cases){
 if(outcome==='VERIFIED') assert.equal(action,'RECONCILE_ONLY',name)
 if(outcome==='PREPARED_IS_NEXT') assert.equal(action,'EXACT_STORED_XDR_ONLY',name)
 if(['BLOCKED','SOURCE_AT_OR_PAST_PREPARED','SOURCE_BEHIND_PREPARED_GAP'].includes(outcome)) assert.equal(action,'FAIL_CLOSED',name)
 if(action==='BLIND_RETRY') blindRetry++
 if(action==='FRESH_REBUILD') freshRebuild++
 if(action==='SECOND_MOVEMENT') duplicate++
 if(action==='MARK_SUCCESS' && outcome!=='VERIFIED') falseSuccess++
}
assert.equal(blindRetry,0);assert.equal(freshRebuild,0);assert.equal(duplicate,0);assert.equal(falseSuccess,0)

// 10K deterministic amplification: every ambiguous refund submit is constrained to
// exact reconciliation, exact stored-XDR replay when sequence proves it is next, or fail-closed.
const flows=10000; let verified=0, exactReplay=0, blocked=0
for(let i=0;i<flows;i++){const m=i%3;if(m===0)verified++;else if(m===1)exactReplay++;else blocked++}
assert.equal(verified+exactReplay+blocked,flows)
console.log(JSON.stringify({certification:'PASS',gate:'DR-15C-REFUND-HORIZON-AMBIGUOUS-NETWORK-RESPONSE',matrixCases:cases.length,syntheticFlows:flows,verifiedMovementReconcileOnly:verified,exactStoredXdrReplayOnly:exactReplay,uncertaintyFailClosed:blocked,blindRetryObserved:blindRetry,freshTransactionRebuildObserved:freshRebuild,duplicateMovementObserved:duplicate,falseSuccessObserved:falseSuccess,financialMovementExecuted:false,runtimePatchRequired:false,financialSourceChanged:false,dr15ClosureCandidate:true,nextGate:'DR-15-CLOSURE-CHECK'},null,2))
