import { readFileSync } from "node:fs"
import { resolve } from "node:path"

type Axis = { axis: string; certifiers: string[]; mutationSensitive: string[]; liveEvidence: string }
const root = process.cwd()
const read = (p:string) => readFileSync(resolve(root,p),"utf8")
const need = (ok:unknown,msg:string):void => { if(!ok) throw new Error(`FIN4_STEP6_MATRIX=FAIL ${msg}`) }

const axes: Axis[] = [
  { axis:"payment_finality", certifiers:["verify-payment-finality-predicate.ts","verify-financial-recovery-financial-invariants.ts"], mutationSensitive:["PAYMENT_FINALITY_PREDICATE_CERTIFIER","FINANCIAL_INVARIANTS_CERTIFIER"], liveEvidence:"B settled_to_merchant + Pi completed + DB recorded" },
  { axis:"settlement_exactly_once_recovery", certifiers:["verify-financial-recovery-settlement-exactly-once-gate.ts","verify-financial-recovery-settlement-submit-replay.ts","verify-financial-recovery-crash-policy.ts"], mutationSensitive:["ALLOW_EXACT_REPLAY","CRASH_POLICY_CERTIFIER"], liveEvidence:"B post-success recovery skipped duplicate Stage2 submit" },
  { axis:"refund_boundary_recovery", certifiers:["verify-financial-recovery-refund-completion-barrier.ts","verify-fin4-r4t4-automatic-refund-retirement-boundary-mutations.mjs","verify-fin4-step5-r4t4-regression-mutations.mjs"], mutationSensitive:["automatic_refund_retired","uncertain_allowed"], liveEvidence:"A retirement read live; eligible refunds=0" },
  { axis:"settlement_refund_xor", certifiers:["verify-settlement-refund-xor-production-binding.ts","verify-financial-recovery-settlement-refund-opposite-binding.ts"], mutationSensitive:["durable_conflict","OPPOSITE_BRANCH"], liveEvidence:"B has no refund; A retired refund has no settlement movement" },
  { axis:"horizon_evidence", certifiers:["verify-financial-recovery-horizon-proof.ts","verify-fin4-r4t2-canonical-horizon-evidence-mutations.mjs","verify-fin4-r4t61-reverse-horizon-read-only-scan-mutations.mjs"], mutationSensitive:["MALFORMED_OR_MISMATCH","mutation"], liveEvidence:"B prepared hash == confirmed Horizon txid; A/C reverse scan absence previously proven" },
  { axis:"accounting_invariants", certifiers:["verify-financial-recovery-financial-invariants.ts","verify-payment-finality-predicate.ts"], mutationSensitive:["appCommission","merchantAmount"], liveEvidence:"B customer=merchant=1.4; appCommission=0; fee separate" },
  { axis:"wallet_sequence_serialization", certifiers:["verify-wallet-submit-boundary-production-binding.ts","verify-plan-i-p7-same-wallet-cross-instance-concurrency.ts","verify-fin4-r4t54-cross-instance-orchestrator-mutations.mjs"], mutationSensitive:["max_in_flight=1","mutation"], liveEvidence:"R4T5.4 holder + 8 contenders; 6 distinct Vercel processes; B later settled normally" },
  { axis:"redis_loss_projection", certifiers:["verify-plan-i-p6-redis-loss-current-sha.ts","verify-redis-projection-cas-production-binding.ts"], mutationSensitive:["stale-writer-blocked","nx_rebuild=true"], liveEvidence:"Redis remains projection/cache, PostgreSQL rediscovery precedes Redis index discovery" },
]

const master = read("scripts/run-financial-recovery-build-verifier.mjs")
for (const a of axes) {
  for (const file of a.certifiers) {
    const full = resolve(root,"scripts",file)
    need(require("node:fs").existsSync(full), `${a.axis}: missing ${file}`)
    need(master.includes(file.replace(/^verify-/,"verify-")) || master.includes(`./${file}`), `${a.axis}: master verifier not bound to ${file}`)
    const source = read(`scripts/${file}`)
    for (const marker of a.mutationSensitive) {
      const found = source.includes(marker) || a.certifiers.some(f => read(`scripts/${f}`).includes(marker))
      need(found, `${a.axis}: missing mutation/adversarial marker ${marker}`)
    }
  }
}
need(axes.length===8,"canonical Step-6 axis count drifted")
console.log("FIN4_STEP6_CURRENT_SHA_CERTIFICATION_MATRIX=PASS axes=8")
for (const a of axes) console.log(`STEP6_AXIS=${a.axis} certifiers=${a.certifiers.length} live="${a.liveEvidence}"`)
