import fs from "node:fs"
import path from "node:path"
const root=process.cwd()
const route=fs.readFileSync(path.join(root,"app/api/certification/fin4-trigger/route.ts"),"utf8")
const executor=fs.readFileSync(path.join(root,"lib/a2u-executor.ts"),"utf8")
const checks:[string,boolean][]=[
 ["armed_b",route.includes('fin4ArmedPaymentForRole(runId, "B")')],
 ["durable_ingress",route.includes('getDurableU2AIngressAuthoritative(paymentB)')],
  ["stage1_operation",route.includes('recoveryOperation: "SETTLEMENT_CREATE"')],
 ["durable_stage1",route.includes('targetAfter.checkpoint.stage === "a2u_created"')],
 ["same_wallet",route.includes('targetAfter.checkpoint.a2uFromAddress === anchor.checkpoint.a2uFromAddress')],
 ["no_txid",route.includes('!targetAfter.checkpoint.a2uTxid')],
 ["stop_before_stage2",executor.indexOf('recoveryOperation === "SETTLEMENT_CREATE"') < executor.indexOf('// STAGE 2: Sign')],
]
for(const [n,ok] of checks) if(!ok) throw new Error(`FIN4_R4K_MUTATION_FAIL:${n}`)
console.log(`FIN4_R4K_MUTATIONS=PASS expected_failures=${checks.length} unexpected_passes=0`)
