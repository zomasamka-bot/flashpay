import fs from "node:fs"
import path from "node:path"
const root=process.cwd()
const route=fs.readFileSync(path.join(root,"app/api/certification/fin4-trigger/route.ts"),"utf8")
const locked=fs.readFileSync(path.join(root,"lib/a2u-locked-executor.ts"),"utf8")
const executor=fs.readFileSync(path.join(root,"lib/a2u-executor.ts"),"utf8")
function must(c:boolean,l:string){if(!c) throw new Error(`FIN4_R4K1_FAIL:${l}`)}
must(route.includes('action: "launch" | "prepare-b-stage1"'),"exact_action")
must(route.includes('fin4ArmedPaymentForRole(runId, "B")'),"armed_b_binding")
must(route.includes('getDurableU2AIngressAuthoritative(paymentB)'),"durable_u2a_required")
must(route.includes('recoveryOperation: "FIN4_STAGE1_PREPARE"'),"cert_operation")
must(locked.includes('params.recoveryOperation === "FIN4_STAGE1_PREPARE"'),"locked_cert_gate")
must(locked.includes('isSettlementDispatchCandidate(latestPayment, now)'),"fresh_dispatch_predicate_reused")
const certGate=locked.indexOf('params.recoveryOperation === "FIN4_STAGE1_PREPARE"')
const dispatchGate=locked.indexOf('params.recoveryOperation === "SETTLEMENT_DISPATCH"')
must(certGate>=0 && dispatchGate>certGate,"cert_gate_before_dispatch")
must(locked.slice(certGate,dispatchGate).includes('isSettlementDispatchCandidate(latestPayment, now)'),"fresh_only")
must(!locked.slice(certGate,dispatchGate).includes('isStage1OnlySettlementDispatchCandidate'),"no_stage1_or_retry_widening")
must(route.includes('targetAfter.checkpoint.stage === "a2u_created"'),"durable_stage1_postcondition")
must(route.includes('targetAfter.checkpoint.a2uFromAddress === anchor.checkpoint.a2uFromAddress'),"same_wallet_postcondition")
must(route.includes('!targetAfter.checkpoint.a2uTxid'),"no_movement_postcondition")
const stop=executor.indexOf('ctx.recoveryOperation === "FIN4_STAGE1_PREPARE"')
const stage2=executor.indexOf('// STAGE 2: Sign')
must(stop>=0 && stage2>stop,"cert_stop_before_stage2")
must(executor.slice(stop,stage2).includes('return { ok: true, status: "settlement_pending" }'),"hard_return_before_stage2")
const callers:string[]=[]
for(const base of ["app","lib"]){
 const walk=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else if(/\.tsx?$/.test(e.name)&&fs.readFileSync(p,"utf8").includes('FIN4_STAGE1_PREPARE')) callers.push(path.relative(root,p))}}
 walk(path.join(root,base))
}
must(callers.filter(x=>x!=="lib/a2u-locked-executor.ts"&&x!=="lib/a2u-executor.ts").length===1 && callers.includes("app/api/certification/fin4-trigger/route.ts"),"cert_only_caller")
console.log("FIN4_R4K1_B_STAGE1_PREPARATION_GATE=PASS exact_b=true fresh_dispatch_contract=true cert_only_operation=true durable_a2u_created=true same_wallet=true no_a2u_txid=true hard_stop_before_stage2=true")
