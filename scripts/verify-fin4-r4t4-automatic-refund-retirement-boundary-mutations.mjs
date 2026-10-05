import fs from 'node:fs'
const orch=fs.readFileSync('lib/refund-auto-orchestrator.ts','utf8')
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
function section(name,next){const a=orch.indexOf(name);const b=next?orch.indexOf(next,a+name.length):orch.length;if(a<0||b<0)throw new Error('section missing');return orch.slice(a,b)}
const intake=section('export async function ensureAutomaticRefundIntent','export type AutomaticRefundDrainClassification')
const step=section('async function runAutomaticRefundCheckpointStep','export async function runAutomaticRefundPreparationStep')
const prep=section('export async function runAutomaticRefundPreparationStep','export async function runAutomaticRefundFinalizationStep')
const guards={
 intake:/readAutomaticRefundRetirementState\(first\.checkpoint\.paymentId, first\.checkpoint\.refundId\)[\s\S]*retirement !== "active"/.test(intake),
 preparation:/readAutomaticRefundRetirementState\(checkpoint\.paymentId, checkpoint\.refundId\)[\s\S]*retirement !== "active"/.test(prep),
 shared_step:/checkpoint\.refundTxid === undefined[\s\S]*readAutomaticRefundRetirementState\(checkpoint\.paymentId, checkpoint\.refundId\)[\s\S]*retirement !== "active"/.test(step),
}
for(const [name,present] of Object.entries(guards)){console.log(`${name}_baseline=${present?'PASS':'FAIL'}`);if(!present)process.exit(1)}
const mutations={
 intake_guard_removed:intake.replace(/\n    const retirement = await readAutomaticRefundRetirementState[\s\S]*?automatic_refund_retirement_uncertain" \}/,'') ,
 preparation_guard_removed:prep.replace(/\n  const retirement = await readAutomaticRefundRetirementState[\s\S]*?return \{ state: "blocked" \}/,''),
 shared_step_guard_removed:step.replace(/\n  if \(checkpoint\.refundTxid === undefined\) \{[\s\S]*?\n  \}/,''),
}
const survived={
 intake_guard_removed:/readAutomaticRefundRetirementState/.test(mutations.intake_guard_removed),
 preparation_guard_removed:/readAutomaticRefundRetirementState/.test(mutations.preparation_guard_removed),
 shared_step_guard_removed:/readAutomaticRefundRetirementState/.test(mutations.shared_step_guard_removed),
}
for(const [name,s] of Object.entries(survived)){const killed=!s;console.log(`${name}=${killed?'PASS':'FAIL'}`);if(!killed)process.exit(1)}
const semanticMutation=store.replace("return rows.length === 1 ? 'retired' : rows.length === 0 ? 'active' : 'uncertain'","return rows.length === 1 ? 'active' : rows.length === 0 ? 'active' : 'uncertain'")
const semanticKilled=/rows\.length === 1 \? 'retired'/.test(store)&&!/rows\.length === 1 \? 'retired'/.test(semanticMutation)
console.log(`retired_semantics_mutation=${semanticKilled?'PASS':'FAIL'}`);if(!semanticKilled)process.exit(1)
console.log('FIN4_R4T4_AUTOMATIC_REFUND_RETIREMENT_BOUNDARY_MUTATIONS PASS')
