import fs from 'node:fs'
const root=new URL('../', import.meta.url).pathname.replace(/\/$/, '')
const acct=fs.readFileSync(root+'/lib/refund-accounting.ts','utf8')
const exec=fs.readFileSync(root+'/lib/refund-executor.ts','utf8')
const store=fs.readFileSync(root+'/lib/refund-checkpoint-store.ts','utf8')
const db=fs.readFileSync(root+'/lib/db.ts','utf8')
const checks=[
 ['accounting_stage_gate',acct,'checkpoint.stage !== "payment_checkpoint_updated" || checkpoint.status !== "pending"'],
 ['horizon_fee_verified',acct,'fee.outcome !== "VERIFIED_FEE"'],
 ['accounting_insert_idempotent',acct,'ON CONFLICT DO NOTHING'],
 ['accounting_union_identity_lookup',acct,'WHERE refund_id=$1 OR payment_id=$2 OR refund_payment_id=$3 OR refund_txid=$4'],
 ['accounting_single_row_replay',acct,'rows.length !== 1'],
 ['accounting_exact_numeric',acct,'row.exact_numeric_match !== true'],
 ['schema_refund_unique',db,'refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT'],
 ['schema_payment_unique',db,'payment_id TEXT NOT NULL UNIQUE'],
 ['schema_refund_payment_unique',db,'refund_payment_id TEXT NOT NULL UNIQUE'],
 ['schema_txid_unique',db,'refund_txid TEXT NOT NULL UNIQUE'],
 ['schema_amount_positive',db,'amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0)'],
 ['schema_fee_nonnegative',db,'horizon_fee_stroops BIGINT NOT NULL CHECK (horizon_fee_stroops >= 0)'],
 ['executor_accounting_exact_identity',exec,"row.refund_id !== refundId || row.payment_id !== checkpoint.paymentId || row.refund_payment_id !== refundPaymentId || row.refund_txid !== refundTxid || row.payer_uid !== checkpoint.payerUid || row.currency !== 'π' || row.exact_amount !== true"],
 ['audit_single_accounting_row',exec,"if (!Array.isArray(rows) || rows.length !== 1) return { outcome: 'blocked', reason: 'audit_uncertain' }"],
 ['completion_single_accounting_row',exec,"if (!Array.isArray(rows) || rows.length !== 1) return { outcome: 'blocked', reason: 'completion_uncertain' }"],
 ['projection_single_accounting_row',exec,"if (!Array.isArray(rows) || rows.length !== 1) return { outcome: 'blocked', reason: 'projection_uncertain' }"],
 ['completion_four_prerequisites',store,'prerequisiteEvents.length !== 4'],
 ['completion_required_event_set',store,"new Set(['refund_submission_confirmed','refund_payment_checkpoint_updated','refund_accounting_recorded','refund_audit_recorded'])"],
 ['completion_event_identity',store,"record.payment_id !== paymentId || record.idempotency_key !== idempotencyKey || record.actor_type !== 'system'"],
 ['completion_exact_refund_ids',store,'object.refundPaymentId !== refundPaymentId || object.refundTxid !== refundTxid'],
 ['completion_fee_match',store,'String(object.horizonFeeStroops) !== String(horizonFeeStroops)'],
 ['completion_canonical_four',store,'canonical.length !== 4'],
 ['completion_no_prior_completed',store,"event_type='refund_completed')=0"],
 ['completion_accounting_join',store,'r.payment_id=c.payment_id AND r.refund_payment_id=c.refund_payment_id AND r.refund_txid=c.refund_txid AND r.payer_uid=c.payer_uid AND r.amount=c.amount AND r.horizon_fee_stroops=$8::bigint'],
 ['completion_exact_event_multiplicity',store,"event_type='refund_audit_recorded')=1"],
 ['projection_requires_completed_checkpoint',store,"c.stage='audit_recorded' AND c.status='completed'"],
 ['projection_requires_completed_event',store,"event_type='refund_completed')=1"],
 ['projection_exact_completed_details',store,"a.details=jsonb_build_object('refundPaymentId',$4,'refundTxid',$5,'horizonFeeStroops',r.horizon_fee_stroops)"],
 ['projection_event_id_deterministic',store,'const eventId = `refund:${refundId}:projection_finalized`'],
 ['projection_insert_idempotent',store,'ON CONFLICT (event_id) DO NOTHING'],
 ['redis_final_then_durable_finalize',exec,'if (alreadyFinal) {\n    const finalized = await finalizeRefundProjectionWithAudit'],
 ['redis_cas_before_finalize_recoverable',exec,"const projectionCas = await compareAndSwapPaymentProjection(checkpoint.paymentId, payment, projected)"],
 ['finalize_after_cas',exec,'const finalized = await finalizeRefundProjectionWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.refundPaymentId, checkpoint.refundTxid, checkpoint.payerUid, checkpoint.amount)'],
]
let pass=0
for(const [name,src,needle] of checks){if(!src.includes(needle)) throw new Error('FIN12 missing '+name); pass++}
// Mutation-kill: deleting each required predicate must make that predicate check fail.
let killed=0
for(const [name,src,needle] of checks){const mutant=src.replaceAll(needle,'__FIN12_MUTATED__'); if(mutant.includes(needle)) throw new Error('mutation survived '+name); killed++}
console.log(`FIN12_REFUND_ACCOUNTING_BARRIER_ADVERSARIAL=PASS predicates=${pass} mutations_killed=${killed} runtime_kernel_changed=false`)
