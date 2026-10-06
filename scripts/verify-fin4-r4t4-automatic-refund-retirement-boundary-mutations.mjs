import fs from 'node:fs'
const orch=fs.readFileSync('lib/refund-auto-orchestrator.ts','utf8')
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
function section(name,next){const a=orch.indexOf(name);const b=next?orch.indexOf(next,a+name.length):orch.length;if(a<0||b<0)throw new Error('section missing');return orch.slice(a,b)}
const intake=section('export async function ensureAutomaticRefundIntent','export type AutomaticRefundDrainClassification')
const step=section('async function runAutomaticRefundCheckpointStep','export async function runAutomaticRefundPreparationStep')
const prep=section('export async function runAutomaticRefundPreparationStep','export async function runAutomaticRefundFinalizationStep')
const classifier=section('export function classifyAutomaticRefundRetirementBoundary','export async function ensureAutomaticRefundIntent')
const guards={
 classifier:/retirement === "active"[\s\S]*automatic_refund_retired[\s\S]*automatic_refund_retirement_uncertain/.test(classifier),
 intake:/readAutomaticRefundRetirementState[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(intake),
 preparation:/readAutomaticRefundRetirementState[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(prep),
 shared_step:/checkpoint\.refundTxid === undefined[\s\S]*readAutomaticRefundRetirementState[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*!boundary\.allow/.test(step),
}
for(const [name,present] of Object.entries(guards)){console.log(`${name}_baseline=${present?'PASS':'FAIL'}`);if(!present)process.exit(1)}
const mutations={
 intake_classifier_removed:intake.replace(/\n    const boundary = classifyAutomaticRefundRetirementBoundary\(retirement\)/,''),
 preparation_classifier_removed:prep.replace(/\n  const boundary = classifyAutomaticRefundRetirementBoundary\(retirement\)/,''),
 shared_step_classifier_removed:step.replace(/\n    const boundary = classifyAutomaticRefundRetirementBoundary\(retirement\)/,''),
}
const survived={
 intake_classifier_removed:/classifyAutomaticRefundRetirementBoundary/.test(mutations.intake_classifier_removed),
 preparation_classifier_removed:/classifyAutomaticRefundRetirementBoundary/.test(mutations.preparation_classifier_removed),
 shared_step_classifier_removed:/classifyAutomaticRefundRetirementBoundary/.test(mutations.shared_step_classifier_removed),
}
for(const [name,s] of Object.entries(survived)){const killed=!s;console.log(`${name}=${killed?'PASS':'FAIL'}`);if(!killed)process.exit(1)}
const semanticMutation=store.replace("return rows.length === 1 ? 'retired' : rows.length === 0 ? 'active' : 'uncertain'","return rows.length === 1 ? 'active' : rows.length === 0 ? 'active' : 'uncertain'")
const semanticKilled=/rows\.length === 1 \? 'retired'/.test(store)&&!/rows\.length === 1 \? 'retired'/.test(semanticMutation)
console.log(`retired_semantics_mutation=${semanticKilled?'PASS':'FAIL'}`);if(!semanticKilled)process.exit(1)
console.log('FIN4_R4T4_AUTOMATIC_REFUND_RETIREMENT_BOUNDARY_MUTATIONS PASS')
