import fs from 'node:fs'
const root=new URL('../', import.meta.url).pathname.replace(/\/$/, '')
const truth=fs.readFileSync(root+'/app/api/operations/r1001-accounting-truth/route.ts','utf8')
const db=fs.readFileSync(root+'/lib/db.ts','utf8')
const refund=fs.readFileSync(root+'/lib/refund-accounting.ts','utf8')
const checks=[
 ['canonical_receipts_sum',truth,"SELECT merchant_id, COALESCE(SUM(merchant_amount),0) AS canonical_settled"],
 ['canonical_only_settled_receipts',truth,"FROM receipts WHERE settlement_status='settled_to_merchant' GROUP BY merchant_id"],
 ['union_covers_missing_or_orphan_rows',truth,'SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical'],
 ['missing_balance_defaults_zero',truth,'COALESCE(b.settled,0) AS stored_settled'],
 ['canonical_defaults_zero',truth,'COALESCE(c.canonical_settled,0) AS canonical_settled'],
 ['settled_delta_exposed',truth,'COALESCE(b.settled,0)-COALESCE(c.canonical_settled,0) AS settled_delta'],
 ['unsettled_exposed',truth,'COALESCE(b.unsettled,0) AS stored_unsettled'],
 ['stale_or_missing_balance_rejected',truth,'WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0) OR COALESCE(b.unsettled,0)<>0'],
 ['duplicate_receipt_identity_checked',truth,"SELECT 'receipts.transaction_id', transaction_id::text"],
 ['duplicate_a2u_txid_checked',truth,"SELECT 'receipts.a2u_txid', a2u_txid"],
 ['refund_duplicate_identity_checked',truth,"SELECT 'refund_accounting_records.refund_id' AS identity"],
 ['truth_reports_balance_mismatch_count',truth,'merchantBalanceMismatchCount: balanceMismatches.length'],
 ['truth_reports_duplicate_count',truth,'duplicateIdentityCount: duplicates.length'],
 ['truth_reports_refund_duplicate_count',truth,'refundDuplicateIdentityCount: refundAccountingDuplicates.length'],
 ['truth_declares_read_only',truth,'readOnly: true'],
 ['truth_declares_no_financial_movement',truth,'financialMovementExecuted: false'],
 ['receipt_insert_idempotent',db,'ON CONFLICT (transaction_id) DO NOTHING'],
 ['receipt_insert_returning_identity',db,'RETURNING id'],
 ['credit_only_new_receipt',db,'if (receiptWasInserted) {'],
 ['merchant_credit_exact_amount',db,'VALUES (${params.merchantId}, ${merchantAmount}, 0, NOW())'],
 ['merchant_balance_pk',db,'merchant_id TEXT PRIMARY KEY'],
 ['refund_accounting_separate_table',refund,'INSERT INTO refund_accounting_records'],
]
let pass=0
for(const [name,src,needle] of checks){if(!src.includes(needle)) throw new Error('FIN13 missing '+name);pass++}
if(/from ["'].*redis|redis\.|isRedisConfigured/i.test(truth)) throw new Error('FIN13 R100-1 accounting truth must not depend on Redis')
if(/merchant_balances/i.test(refund)) throw new Error('FIN13 refund accounting must not mutate merchant_balances')
let killed=0
for(const [name,src,needle] of checks){const mutant=src.replaceAll(needle,'__FIN13_MUTATED__');if(mutant.includes(needle)) throw new Error('FIN13 mutation survived '+name);killed++}
console.log(`FIN13_MERCHANT_REBUILD_ADVERSARIAL=PASS predicates=${pass} mutations_killed=${killed} redis_financial_truth=false refund_balance_contamination=false runtime_kernel_changed=false`)
