import fs from 'node:fs'
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const orch=fs.readFileSync('lib/refund-auto-orchestrator.ts','utf8')
const transient=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const checks={
  shared_predicate_export:/export async function readAutomaticRefundRetirementState/.test(store),
  predicate_schema_first:/readAutomaticRefundRetirementState[\s\S]*ensureRefundCheckpointTables\(\)[\s\S]*SELECT 1 FROM refund_automatic_retirements/.test(store),
  predicate_exact_pair:/WHERE payment_id=\$1 AND refund_id=\$2/.test(store),
  predicate_fail_closed:/catch \{\s*return 'uncertain'\s*\}/.test(store),
  shared_classifier:/export function classifyAutomaticRefundRetirementBoundary[\s\S]*retirement === "active"[\s\S]*automatic_refund_retired[\s\S]*automatic_refund_retirement_uncertain/.test(orch),
  intake_guard:/ensureAutomaticRefundIntent[\s\S]*readAutomaticRefundRetirementState\(first\.checkpoint\.paymentId, first\.checkpoint\.refundId\)[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(orch),
  preparation_guard:/runAutomaticRefundPreparationStep[\s\S]*readAutomaticRefundRetirementState\(checkpoint\.paymentId, checkpoint\.refundId\)[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(orch),
  shared_step_guard:/runAutomaticRefundCheckpointStep[\s\S]*checkpoint\.refundTxid === undefined[\s\S]*readAutomaticRefundRetirementState[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(orch),
  finalization_requires_movement:/runAutomaticRefundFinalizationStep[\s\S]*refundPaymentId[\s\S]*refundTxid/.test(orch),
  transient_uses_guarded_intake:/ensureAutomaticRefundIntent\(paymentId\)/.test(transient)&&/runAutomaticRefundPreparationStep\(paymentId, intake\.refundId\)/.test(transient),
  no_retirement_delete:!/(DELETE FROM refund_automatic_retirements|UPDATE refund_automatic_retirements)/.test(store+orch),
}
for(const [k,v] of Object.entries(checks)) console.log(`${k}=${v?'PASS':'FAIL'}`)
if(Object.values(checks).some(v=>!v)) process.exit(1)
console.log('FIN4_R4T4_AUTOMATIC_REFUND_RETIREMENT_BOUNDARY PASS')
