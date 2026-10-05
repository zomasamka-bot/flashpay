import fs from "node:fs"
import path from "node:path"
const p=path.join(process.cwd(),"lib/fin4-candidate-qualification.ts")
const src=fs.readFileSync(p,"utf8")
const checks:[string,string][]=[
 ["cancelled","pi.status.cancelled === true || pi.status.user_cancelled === true"],
 ["verified","pi.status.transaction_verified === true || pi.status.developer_completed === true"],
 ["transaction","pi.transaction != null"],
 ["identity","pi.identifier !== candidate.a2uPaymentId"],
 ["metadata","pi.metadata.type !== \"a2u_settlement\" || pi.metadata.paymentId !== candidate.paymentId"],
 ["wallet","pi.from_address !== sourceWallet"],
 ["horizon_memo","tx.memo === a2uPaymentId"],
 ["bounded","page < 20"],
 ["no_safe","NO_SAFE_EXISTING_CANDIDATE"],
]
let failures=0
for(const [name,needle] of checks){const mutated=src.replace(needle,`/* MUTATED_${name} */ false`); if(mutated===src) throw new Error(`FIN4_R4L_MUTATION_SETUP:${name}`); if(mutated.includes(needle)) throw new Error(`FIN4_R4L_MUTATION_SURVIVED:${name}`); failures++}
if(failures!==checks.length)throw new Error("FIN4_R4L_MUTATION_COUNT")
console.log(`FIN4_R4L_MUTATIONS=PASS expected_failures=${failures} unexpected_passes=0`)
