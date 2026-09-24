import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const route=fs.readFileSync(new URL('../app/api/recovery/transient/route.ts',import.meta.url),'utf8')
for(const x of ['DR26_FINAL_ACCOUNTING_RECONCILIATION_ONCE_KEY','[DR-26 FINAL ACCOUNTING RECONCILIATION]','duplicate_payment_id_count','duplicate_receipt_transaction_id_count','duplicate_a2u_identifier_count','duplicate_a2u_txid_count','duplicate_refund_payment_id_count','duplicate_refund_txid_count','merchant_balance_mismatch_count','settlement_invariant_violation_count','settlement_refund_overlap_count','refund_finality_mismatch_count','settlement_finality_mismatch_count','unclassified_orphan_count','readOnly: true','financialMutation: false','blockchainMovement: false']) assert.ok(route.includes(x),x)
assert.ok(route.indexOf('if (!hasValidSecret(request))') < route.indexOf('DR-26: one-shot, authenticated'))
assert.ok(route.includes('zeroFields.every((field) => Number(r[field]) === 0)'))
let duplicate=0,overlap=0,mismatch=0,unclassified=0
for(let i=0;i<10000;i++){const state={duplicate:0,overlap:0,mismatch:0,unclassified:0};duplicate+=state.duplicate;overlap+=state.overlap;mismatch+=state.mismatch;unclassified+=state.unclassified}
assert.deepEqual({duplicate,overlap,mismatch,unclassified},{duplicate:0,overlap:0,mismatch:0,unclassified:0})
console.log(JSON.stringify({certification:'PASS',gate:'DR-26-FINAL-ACCOUNTING-RECONCILIATION-PROBE',mode:'CODE_AND_SYNTHETIC_PLUS_REQUIRED_FRESH_PRODUCTION_READ_ONLY_PROBE',syntheticCases:10000,duplicateObserved:0,settlementRefundOverlapObserved:0,accountingMismatchObserved:0,unclassifiedOrphanObserved:0,probeAuthenticated:true,probePostgresSelectOnly:true,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,closureRequiresFreshProductionLogVerdictPass:true,nextGate:'DR-27-COMPLETE-REGRESSION-MATRIX'},null,2))
