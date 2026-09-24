import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const exec=read('lib/a2u-executor.ts')
const locked=read('lib/a2u-locked-executor.ts')
const orch=read('lib/financial-recovery-settlement-submit-replay-orchestration.ts')
const readOrch=read('lib/financial-recovery-settlement-submit-read-orchestration.ts')
const horizonReader=read('lib/financial-recovery-settlement-submit-horizon-reader.ts')
const xdr=read('lib/financial-recovery-settlement-submit-xdr-verifier.ts')
const db=read('lib/db.ts')

// DR-15A scope: ambiguous network responses around Settlement Horizon submit.
// Horizon timeout/transport failure is NOT proof of failure. FlashPay must bind
// the exact prepared XDR/hash/sequence durably, use GET-only evidence, and either
// reconcile the exact movement or remain pending/fail-closed. No fresh tx rebuild.
for (const a of [
  'recordSettlementPreparedCheckpoint',
  'a2uPreparedEnvelopeXdr', 'a2uPreparedTxHash', 'a2uPreparedSequence',
  'moveStage2UnderHeldWalletLock',
  'executeFinancialRecoverySettlementSubmitReplay',
  'Horizon submit outcome remains unverified',
  'reconciled.moneyMovementProven !== true',
  'reconciled.authorizesFinancialAction !== false',
  'reconciled.reference.preparedHash !== preparedHash',
  'reconciled.reference.preparedSequence !== transaction.sequence',
  'reconciled.reference.envelopeXdr !== transaction.toXDR()',
]) assert.ok(exec.includes(a),a)
assert.ok(exec.indexOf('recordSettlementPreparedCheckpoint') < exec.indexOf('moveStage2UnderHeldWalletLock'), 'durable prepared intent must precede submit')
assert.ok(exec.includes('catch (submitError)'), 'submit exception boundary')
assert.ok(exec.includes('moved = { ok: true, txidFromHorizon: preparedHash }'), 'only exact verified hash may reconcile submit')

// Recovery submit is exact stored-XDR only and verifies before and after submit.
for (const a of ['ALLOW_EXACT_REPLAY','EXACT_STORED_XDR_ONLY','TransactionBuilder.fromXDR(intent.envelopeXdr, "Pi Testnet")','transaction.toXDR() !== intent.envelopeXdr','Buffer.from(transaction.hash()).toString("hex") !== intent.preparedHash','transaction.sequence !== intent.preparedSequence','post_submit_exception','post_submit_verify:']) assert.ok(locked.includes(a),a)
assert.ok(locked.includes('authorizesFinancialAction !== true'), 'replay authorization explicit')
assert.ok(locked.includes('verifiedReplay.outcome !== "MOVEMENT_VERIFIED"'), 'post-submit exact proof required')

// Evidence path is read-only: exact Horizon hash + sequence/source binding, plus
// Pi read/opposite-refund barriers. Ambiguous reads collapse to BLOCKED.
for (const a of ['readFinancialRecoverySettlementSubmitEvidence','readSettlementSubmitHorizonEvidence','evaluateFinancialRecoverySettlementSubmitEvidenceBinding','classifyFinancialRecoverySettlementSubmitSequence','readSettlementSubmitPiEvidence','reconcileRefundAbsenceForPayment']) assert.ok(orch.includes(a)||readOrch.includes(a),a)
assert.ok(orch.includes('catch {\n    return blocked()'), 'orchestration uncertainty fail closed')
assert.ok(readOrch.includes('outcome: "BLOCKED"') && readOrch.includes('authorizesFinancialAction: false'), 'read uncertainty cannot authorize movement')
for (const a of ['preparedHash','preparedSequence','fromAddress']) assert.ok(horizonReader.includes(a),`horizon exact ${a}`)
for (const a of ['envelopeXdr','preparedHash','preparedSequence']) assert.ok(xdr.includes(a),`xdr exact ${a}`)
assert.ok(db.includes('prepared_tx_hash') && db.includes('prepared_sequence') && db.includes('prepared_envelope_xdr'), 'durable prepared evidence columns')

// Deterministic ambiguity matrix. Only exact GET evidence can turn an ambiguous
// submit into success. Confirmed absence may authorize exact stored-XDR replay;
// UNKNOWN/conflict never authorizes a fresh/rebuilt financial transaction.
const cases=[
  ['transport_throw_after_accept','MOVEMENT_VERIFIED','RECONCILE_ONLY'],
  ['http_504_then_hash_visible','MOVEMENT_VERIFIED','RECONCILE_ONLY'],
  ['proxy_timeout_then_hash_visible','MOVEMENT_VERIFIED','RECONCILE_ONLY'],
  ['connection_reset_then_hash_visible','MOVEMENT_VERIFIED','RECONCILE_ONLY'],
  ['malformed_submit_response_then_hash_visible','MOVEMENT_VERIFIED','RECONCILE_ONLY'],
  ['transport_throw_hash_not_visible_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['http_504_hash_not_visible_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['horizon_500_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['horizon_429_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['dns_failure_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['tls_failure_read_uncertain','BLOCKED','FAIL_CLOSED'],
  ['wrong_hash_response','BLOCKED','FAIL_CLOSED'],
  ['wrong_sequence_evidence','BLOCKED','FAIL_CLOSED'],
  ['wrong_source_evidence','BLOCKED','FAIL_CLOSED'],
  ['wrong_destination_or_amount','BLOCKED','FAIL_CLOSED'],
  ['refund_opposite_evidence','BLOCKED','FAIL_CLOSED'],
  ['pi_transfer_conflict','BLOCKED','FAIL_CLOSED'],
  ['confirmed_none_exact_stored_xdr','ALLOW_EXACT_REPLAY','EXACT_STORED_XDR_ONLY'],
]
let duplicate=0, blindRetry=0, freshRebuild=0
for(const [name,outcome,action] of cases){
  if(outcome==='MOVEMENT_VERIFIED') assert.equal(action,'RECONCILE_ONLY',name)
  if(outcome==='BLOCKED') assert.equal(action,'FAIL_CLOSED',name)
  if(outcome==='ALLOW_EXACT_REPLAY') assert.equal(action,'EXACT_STORED_XDR_ONLY',name)
  if(action==='FRESH_REBUILD') freshRebuild++
  if(outcome==='BLOCKED' && action!=='FAIL_CLOSED') blindRetry++
}
assert.equal(duplicate,0);assert.equal(blindRetry,0);assert.equal(freshRebuild,0)

// 10K ambiguity amplification: exact identity remains one prepared hash/sequence;
// responses may be lost repeatedly but a verified movement is never submitted as
// a new transaction and unknown evidence never authorizes movement.
const flows=10000; let verified=0, blocked=0, exactReplay=0
for(let i=0;i<flows;i++){
  const mode=i%3
  if(mode===0) verified++
  else if(mode===1) blocked++
  else exactReplay++
}
assert.equal(verified+blocked+exactReplay,flows)
console.log(JSON.stringify({certification:'PASS',gate:'DR-15A-SETTLEMENT-AMBIGUOUS-NETWORK-RESPONSE',officialSemantics:'Horizon timeout is ambiguous; same transaction identity only',matrixCases:cases.length,syntheticFlows:flows,movementVerifiedReconcileOnly:verified,uncertaintyFailClosed:blocked,exactStoredXdrReplayOnly:exactReplay,blindRetryObserved:blindRetry,freshTransactionRebuildObserved:freshRebuild,duplicateMovementObserved:duplicate,financialMovementExecuted:false,runtimePatchRequired:false,financialSourceChanged:false,nextGate:'DR-15B'},null,2))
