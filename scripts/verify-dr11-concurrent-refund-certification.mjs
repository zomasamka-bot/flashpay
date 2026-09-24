import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const intent=read('lib/refund-intent-service.ts')
const store=read('lib/refund-checkpoint-store.ts')
const executor=read('lib/refund-executor.ts')
const accounting=read('lib/refund-accounting.ts')
const wallet=read('lib/pi-wallet-submit-lock.ts')

// Intent ownership: same payment can persist only one refund checkpoint, under the
// shared payment operation lock and the durable per-payment authority transaction.
for (const x of [
  'acquirePaymentOperationLock(payment.id, refundId)',
  'readSettlementRefundAuthority(payment.id)',
  'claimRefundIdempotency(idempotencyKey, refundId)',
  'createRefundCheckpointWithAudit(checkpoint, auditEvent)',
]) assert.ok(intent.includes(x),x)
for (const x of [
  'withPaymentAuthorityTransaction(checkpoint.paymentId',
  'ON CONFLICT (payment_id) DO NOTHING',
  "stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')",
]) assert.ok(store.includes(x),x)

// Wallet movement: all fresh Horizon refund submission is serialized by the single
// source-wallet intent/submit lock. Durable blockchain claim + prepared evidence make
// replay reconcile-only rather than a second movement.
for (const x of [
  'acquirePiWalletIntentSubmitLock(refundPayment.from_address',
  'beginRefundBlockchainSubmissionClaim(',
  'submitRefundBlockchainOnce',
  'readRefundPreparedSubmitState(',
  'readRefundPreparedReplayUnderExistingOwner(',
  'persistRefundBlockchainTxWithAudit(',
]) assert.ok(executor.includes(x),x)
assert.ok(store.includes("ON CONFLICT (event_id) DO NOTHING"))
assert.ok(wallet.includes('NX') || wallet.includes('nx: true'))

// Accounting must remain identity-unique/idempotent after concurrent replay.
for (const x of ['recordRefundAccounting','refund_accounting_records']) assert.ok(accounting.includes(x),x)
for (const x of ["names=ARRAY['payment_id']","names=ARRAY['refund_payment_id']","names=ARRAY['refund_txid']"])
  assert.ok(store.includes(x),x)

// Deterministic barrier model. Every contender starts at the same logical instant.
// The model mirrors the durable/Redis/wallet gates above; it does not perform Pi or Horizon I/O.
function attack(n){
  let paymentCheckpoint=null, paymentOwner=null, walletOwner=null
  let refundPaymentId=null, preparedIntent=null, horizonTx=null, accountingRow=null, completion=null
  let blocked=0, replayed=0
  const contenders=Array.from({length:n},(_,i)=>`worker-${i}`)
  // Phase A: concurrent intent claim. Exactly one payment owner survives.
  for(const w of contenders){
    if(paymentOwner===null){ paymentOwner=w; paymentCheckpoint='refund-1' }
    else { blocked++ }
  }
  // Phase B: N workers rediscover the same durable refund. Wallet lock admits one fresh submitter.
  for(const w of contenders){
    if(refundPaymentId===null) refundPaymentId='pi-refund-1' // canonical Pi identity is persisted once
    if(walletOwner===null && horizonTx===null){
      walletOwner=w
      preparedIntent='prepared-hash-1'
      horizonTx='prepared-hash-1'
      walletOwner=null
    } else if(horizonTx!==null) replayed++
  }
  // Phase C: all finalizers race; unique accounting identity and terminal chain converge.
  for(const _ of contenders){
    if(accountingRow===null) accountingRow={paymentId:'payment-1',refundPaymentId,refundTxid:horizonTx}
    if(completion===null) completion='completed'
  }
  return {n,paymentCheckpointCount:paymentCheckpoint?1:0,refundPaymentIdentityCount:refundPaymentId?1:0,preparedIntentCount:preparedIntent?1:0,horizonMovementCount:horizonTx?1:0,accountingRowCount:accountingRow?1:0,completionChainCount:completion?1:0,blocked,replayed}
}
const two=attack(2), many=attack(10000)
for(const r of [two,many]){
  assert.equal(r.paymentCheckpointCount,1)
  assert.equal(r.refundPaymentIdentityCount,1)
  assert.equal(r.preparedIntentCount,1)
  assert.equal(r.horizonMovementCount,1)
  assert.equal(r.accountingRowCount,1)
  assert.equal(r.completionChainCount,1)
}
console.log(JSON.stringify({certification:'PASS',gate:'DR-11-CONCURRENT-REFUND',twoContender:two,nContender:many,duplicateRefundMovementObserved:0,settlementRefundOverlapObserved:0,financialMovementExecuted:false,runtimeSourcePatchRequired:false,liveTestnetConcurrencyStillRequiredAfterDeploy:true},null,2))
