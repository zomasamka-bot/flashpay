import fs from 'node:fs'
import vm from 'node:vm'
const orch=fs.readFileSync('lib/refund-auto-orchestrator.ts','utf8')
const match=orch.match(/export function classifyAutomaticRefundRetirementBoundary\([\s\S]*?\n\}/)
if(!match)throw new Error('Step5 classifier missing')
function compile(src){
 const js=src.replace('export function ','function ').replace(/\n  retirement: "active" \| "retired" \| "uncertain",\n/,'\n  retirement,\n').replace(/\): AutomaticRefundRetirementBoundaryDecision \{/,') {')
 const c={};vm.createContext(c);vm.runInContext(`${js};this.classify=classifyAutomaticRefundRetirementBoundary`,c);return c.classify
}
function contract(fn){
 const a=fn('active'),r=fn('retired'),u=fn('uncertain')
 return a?.allow===true&&a?.reason===undefined&&r?.allow===false&&r?.reason==='automatic_refund_retired'&&u?.allow===false&&u?.reason==='automatic_refund_retirement_uncertain'
}
if(!contract(compile(match[0])))throw new Error('baseline contract failed')
const mutations={
 active_blocked:match[0].replace('if (retirement === "active") return { allow: true }','if (retirement === "active") return { allow: false, reason: "automatic_refund_retirement_uncertain" }'),
 retired_allowed:match[0].replace('return { allow: false, reason: retirement === "retired" ? "automatic_refund_retired" : "automatic_refund_retirement_uncertain" }','if (retirement === "retired") return { allow: true }\n  return { allow: false, reason: "automatic_refund_retirement_uncertain" }'),
 uncertain_allowed:match[0].replace('return { allow: false, reason: retirement === "retired" ? "automatic_refund_retired" : "automatic_refund_retirement_uncertain" }','if (retirement === "uncertain") return { allow: true }\n  return { allow: false, reason: "automatic_refund_retired" }'),
 retired_reason_lost:match[0].replace('"automatic_refund_retired" : "automatic_refund_retirement_uncertain"','"automatic_refund_retirement_uncertain" : "automatic_refund_retirement_uncertain"'),
}
for(const [name,src] of Object.entries(mutations)){const killed=!contract(compile(src));console.log(`${name}=${killed?'PASS':'FAIL'}`);if(!killed)process.exit(1)}
console.log('FIN4_STEP5_R4T4_REGRESSION_MUTATIONS PASS')
