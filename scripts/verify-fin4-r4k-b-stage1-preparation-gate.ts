import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const route = fs.readFileSync(path.join(root, "app/api/certification/fin4-trigger/route.ts"), "utf8")
const executor = fs.readFileSync(path.join(root, "lib/a2u-executor.ts"), "utf8")

function must(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FIN4_R4K_FAIL:${label}`)
}

must(route.includes('action: "launch" | "prepare-b-stage1"'), "exact_action")
must(route.includes('fin4ArmedPaymentForRole(runId, "B")'), "armed_b_binding")
must(route.includes('getDurableU2AIngressAuthoritative(paymentB)'), "durable_u2a_required")
must(route.includes('executeA2ULocked({ paymentId: paymentB, isRecovery: true, recoveryOperation: "SETTLEMENT_CREATE" })'), "existing_stage1_only_operation")
must(route.includes('targetAfter.checkpoint.stage === "a2u_created"'), "durable_stage1_postcondition")
must(route.includes('targetAfter.checkpoint.a2uFromAddress === anchor.checkpoint.a2uFromAddress'), "same_wallet_postcondition")
must(route.includes('!targetAfter.checkpoint.a2uTxid'), "no_movement_postcondition")
must(route.includes('const readiness = await readArmedReadiness(runId)'), "readiness_reread")

const stop = executor.indexOf('if (ctx.isRecovery && ctx.recoveryOperation === "SETTLEMENT_CREATE")')
const stage2 = executor.indexOf('// STAGE 2: Sign')
must(stop >= 0 && stage2 >= 0 && stop < stage2, "settlement_create_returns_before_stage2")
must(executor.slice(stop, stage2).includes('return { ok: true, status: "settlement_pending" }'), "hard_return_before_stage2")

console.log("FIN4_R4K_B_STAGE1_PREPARATION_GATE=PASS exact_b=true durable_u2a=true existing_stage1_operation=true durable_a2u_created=true same_wallet=true no_a2u_txid=true hard_stop_before_stage2=true readiness_reread=true")
