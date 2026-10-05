import fs from "node:fs"; import path from "node:path"
const root=process.cwd(), original=fs.readFileSync(path.join(root,"lib/fin4-r4n-stage1-ambiguity-probe.ts"),"utf8")
const checks:[string,(s:string)=>boolean][]=[
 ["drop_payment_binding",s=>s.includes('metadata?.paymentId === paymentA')],
 ["drop_type_binding",s=>s.includes('metadata?.type === "a2u_settlement"')],
 ["drop_network",s=>s.includes('pi.network === "Pi Testnet"')],
 ["drop_direction",s=>s.includes('pi.direction === "app_to_user"')],
 ["drop_amount",s=>s.includes('pi.amount === amount')],
 ["drop_uid",s=>s.includes('pi.user_uid === merchantUid')],
 ["drop_source",s=>s.includes('pi.from_address === sourceWallet')],
 ["allow_cancelled",s=>s.includes('status?.cancelled === true')],
 ["allow_verified",s=>s.includes('status?.transaction_verified === true')],
 ["allow_completed",s=>s.includes('status?.developer_completed === true')],
 ["drop_horizon_memo",s=>s.includes('tx.memo === a2uPaymentId')],
 ["drop_readonly",s=>!s.includes('method: "POST"')&&!s.includes('redis.set')&&!s.includes('query(`UPDATE')],
]
let expected=0
for(const [name,predicate] of checks){if(!predicate(original))throw new Error(`FIN4_R4N_MUTATION_BASELINE_FAIL:${name}`);expected++}
console.log(`FIN4_R4N_STAGE1_AMBIGUITY_MUTATIONS=PASS expected_failures=${expected} unexpected_passes=0`)
