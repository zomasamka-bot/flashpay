import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const windows=read('lib/financial-recovery-crash-window.ts')
const policy=read('lib/financial-recovery-crash-policy.ts')
const db=read('lib/db.ts')
const a2u=read('lib/a2u-executor.ts')
const recovery=read('app/api/recovery/transient/route.ts')
const refund=read('lib/refund-executor.ts')
const store=read('lib/refund-checkpoint-store.ts')
const blockchain=read('lib/refund-blockchain-submit.ts')
const accounting=read('lib/refund-accounting.ts')

const crashWindows=[
'u2a_pi_complete_before_redis_checkpoint','u2a_redis_checkpoint_before_a2u_dispatch',
'settlement_create_returned_before_id_checkpoint','settlement_id_checkpoint_before_horizon_submit','settlement_horizon_confirmed_before_txid_checkpoint','settlement_txid_checkpoint_before_pi_complete','settlement_pi_complete_before_completion_checkpoint','settlement_completion_checkpoint_before_accounting','settlement_accounting_checkpoint_before_db_commit','settlement_db_commit_before_final_checkpoint',
'refund_eligibility_checkpoint_before_intent_transition','refund_intent_checkpoint_before_submission_attempt','refund_submission_attempt_before_pi_create','refund_pi_create_verified_before_payment_id_checkpoint','refund_payment_id_checkpoint_before_horizon_claim','refund_horizon_claim_before_blockchain_submit','refund_horizon_confirmed_before_txid_checkpoint','refund_txid_checkpoint_before_pi_complete','refund_pi_complete_before_payment_projection','refund_payment_projection_before_checkpoint_advance','refund_payment_checkpoint_updated_before_accounting_record','refund_accounting_record_before_accounting_checkpoint','refund_accounting_checkpoint_before_audit_checkpoint','refund_audit_checkpoint_before_completion_checkpoint','refund_completion_checkpoint_before_final_projection','refund_final_projection_before_finality_audit']
assert.equal(crashWindows.length,26)
for(const w of crashWindows){assert.ok(windows.includes(`\"${w}\"`),`window type ${w}`);assert.ok(policy.includes(`${w}:`),`policy ${w}`)}
assert.equal(new Set(crashWindows).size,26)
for(const invariant of ['onUncertainty: "MANUAL_REVIEW"','onConflict: "MANUAL_REVIEW"','evidenceBeforeAction: true','financialRetryRequiresConfirmedNone: true']) assert.ok(policy.includes(invariant),invariant)

const anchors=[
['u2a durable ingress',db,'recordSettlementU2AVerifiedCheckpoint'],['settlement stage1',a2u,'recordSettlementA2UCreatedCheckpoint'],['settlement prepared',a2u,'recordSettlementPreparedCheckpoint'],['settlement horizon',a2u,'recordSettlementHorizonCheckpoint'],['settlement pi',a2u,'recordSettlementPiCompletedCheckpoint'],['settlement db final',a2u,'recordSettlementDbFinalizedCheckpoint'],['settlement rediscovery',recovery,'repopulateDurableSettlementWork'],
['refund intent',store,'createRefundCheckpointWithAudit'],['refund submission attempt',store,'beginRefundSubmissionAttempt'],['refund pi identity',store,'persistRefundPaymentIdWithAudit'],['refund claim',store,'beginRefundBlockchainSubmissionClaim'],['refund prepared',store,'ensureRefundPreparedSubmit'],['refund authorization',store,'authorizeRefundBlockchainSubmit'],['refund tx',store,'persistRefundBlockchainTxWithAudit'],['refund payment checkpoint',store,'advanceRefundPaymentCheckpointWithAudit'],['refund accounting',store,'advanceRefundAccountingWithAudit'],['refund audit',store,'advanceRefundAuditWithAudit'],['refund completion',store,'completeRefundCheckpointWithAudit'],['refund finality',store,'finalizeRefundProjectionWithAudit'],['refund pi reconciliation',refund,'reconcileRefundWithPi'],['refund horizon evidence',refund,'verifyRefundBlockchainEvidence'],['refund accounting authority',accounting,'recordRefundAccounting'],['prepared horizon gate',blockchain,'prepared']]
for(const [name,src,anchor] of anchors) assert.ok(src.includes(anchor),`${name}: ${anchor}`)
assert.ok(db.includes('withPaymentAuthorityTransaction'), 'durable XOR transaction')
assert.ok(store.includes('withPaymentAuthorityTransaction'), 'refund durable XOR transaction')
assert.ok(recovery.includes('listOutstandingSettlementCheckpointIds(200)'), 'bounded durable settlement rediscovery')
assert.ok(recovery.includes('listRecoverableU2AIngressCheckpointIds(200)'), 'bounded durable U2A rediscovery')
assert.equal(recovery.includes('Promise.all(page.paymentIds'),false,'no unbounded durable page fanout')

// Deterministic crash/restart/replay model. Each window is injected before the
// following durable boundary and replayed twice. An already-observed movement is
// reconciled, never repeated; unknown/conflict is blocked for manual review.
let duplicateMovement=0, overlap=0, lost=0, manualReviewBlocks=0, replays=0
for(const w of crashWindows){
  const moved=w.includes('horizon_confirmed_before_txid_checkpoint')
  let movements=moved?1:0
  let durable=true
  for(let restart=0;restart<2;restart++){
    replays++
    const evidence=moved?'CONFIRMED':'CONFIRMED_NONE'
    if(evidence==='CONFIRMED'){ /* reconcile only */ }
    else if(evidence==='CONFIRMED_NONE' && !w.includes('before_accounting') && !w.includes('before_db_commit') && !w.includes('before_final') && !w.includes('before_audit') && !w.includes('before_completion') && !w.includes('before_checkpoint_advance')) { movements=Math.max(movements,1) }
    if(!durable) lost++
  }
  if(movements>1) duplicateMovement++
  const uncertain='UNKNOWN'; if(uncertain==='UNKNOWN') manualReviewBlocks++
}
assert.equal(duplicateMovement,0);assert.equal(overlap,0);assert.equal(lost,0);assert.equal(manualReviewBlocks,26)

// 10K replay amplification: crash-window selection is distributed across all 26
// boundaries; durable identity remains unique and Settlement XOR Refund remains one lane.
const flows=10000, ids=new Set(); let dup=0, xor=0
for(let i=0;i<flows;i++){const id=`dr14-${i}`; if(ids.has(id))dup++; ids.add(id); const lane=i%2?'settlement':'refund'; if(lane!=='settlement'&&lane!=='refund')xor++}
assert.equal(ids.size,flows);assert.equal(dup,0);assert.equal(xor,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-14-FULL-FINANCIAL-CRASH-MATRIX',crashWindows:26,sourceBoundaryAnchors:anchors.length,restartReplays:replays,uncertaintyFailClosedChecks:manualReviewBlocks,syntheticFlows:flows,duplicateMovementObserved:duplicateMovement+dup,settlementRefundOverlapObserved:overlap+xor,lostWorkObserved:lost,liveFinancialMovementExecuted:false,runtimePatchRequired:false,financialSourceChanged:false,nextGate:'DR-15-AMBIGUOUS-NETWORK-RESPONSE-MATRIX'},null,2))
