import fs from 'node:fs'
import vm from 'node:vm'

const orch = fs.readFileSync('lib/refund-auto-orchestrator.ts', 'utf8')

const fnMatch = orch.match(/export function classifyAutomaticRefundRetirementBoundary\([\s\S]*?\n\}/)
if (!fnMatch) throw new Error('Step5 classifier missing')
const executable = fnMatch[0]
  .replace('export function ', 'function ')
  .replace(/\n  retirement: "active" \| "retired" \| "uncertain",\n/, '\n  retirement,\n')
  .replace(/\): AutomaticRefundRetirementBoundaryDecision \{/, ') {')

const context = {}
vm.createContext(context)
vm.runInContext(`${executable}; this.classify=classifyAutomaticRefundRetirementBoundary`, context)
const classify = context.classify

const cases = [
  ['active', true, undefined],
  ['retired', false, 'automatic_refund_retired'],
  ['uncertain', false, 'automatic_refund_retirement_uncertain'],
]
for (const [state, allow, reason] of cases) {
  const got = classify(state)
  const pass = got?.allow === allow && got?.reason === reason
  console.log(`step5_${state}=${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(got)}`)
  if (!pass) process.exit(1)
}

const checks = {
  intake_uses_shared_classifier: /ensureAutomaticRefundIntent[\s\S]*readAutomaticRefundRetirementState\(first\.checkpoint\.paymentId, first\.checkpoint\.refundId\)[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*if \(!boundary\.allow\)/.test(orch),
  checkpoint_uses_shared_classifier: /runAutomaticRefundCheckpointStep[\s\S]*checkpoint\.refundTxid === undefined[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*if \(!boundary\.allow\)/.test(orch),
  preparation_uses_shared_classifier: /runAutomaticRefundPreparationStep[\s\S]*readAutomaticRefundRetirementState\(checkpoint\.paymentId, checkpoint\.refundId\)[\s\S]*classifyAutomaticRefundRetirementBoundary\(retirement\)[\s\S]*if \(!boundary\.allow\)/.test(orch),
  finalization_not_retirement_blocked: (() => { const a=orch.indexOf('export async function runAutomaticRefundFinalizationStep'); const b=orch.indexOf('export async function runAutomaticRefundPass',a); return a>=0&&b>a&&!orch.slice(a,b).includes('classifyAutomaticRefundRetirementBoundary') })(),
}
for (const [name, pass] of Object.entries(checks)) { console.log(`${name}=${pass?'PASS':'FAIL'}`); if (!pass) process.exit(1) }
console.log('FIN4_STEP5_R4T4_NORMAL_AND_RETIRED_REGRESSION PASS')
