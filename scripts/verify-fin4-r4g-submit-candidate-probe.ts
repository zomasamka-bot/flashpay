import fs from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "..")
const reader = fs.readFileSync(path.join(root, "lib/fin4-submit-candidate-reader.ts"), "utf8")
const route = fs.readFileSync(path.join(root, "app/api/certification/fin4-trigger/route.ts"), "utf8")

function must(condition: boolean, message: string) {
  if (!condition) throw new Error(`FIN4_R4G_VERIFY_FAIL: ${message}`)
}

must(reader.includes('FROM settlement_checkpoints s'), "reader must inspect durable settlement rows")
must(reader.includes("s.a2u_from_address=$1"), "reader must bind exact source wallet")
must(reader.includes('r.status<>\'manual_review_required\''), "reader must inspect opposite Refund authority")
must(reader.includes('SETTLEMENT_SUBMIT_ENTRY_CANDIDATE'), "prepared candidate class missing")
must(reader.includes('PREPARATION_REQUIRED_STAGE1'), "stage1 preparation class missing")
must(reader.includes('provesTwoSubmitEntryCandidates: submit.length >= 2'), "two-candidate proof must be count based")
must(!/\b(INSERT|UPDATE|DELETE|UPSERT)\b/i.test(reader.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "reader must remain SELECT-only")
must(!reader.includes("submitTransaction"), "reader must not submit Horizon")
must(!reader.includes('api.minepi.com'), "reader must not call Pi")
must(!reader.includes("redis."), "reader must not mutate/read Redis")
must(route.includes('evidence") === "submit-candidates"'), "route must expose submit-candidates evidence mode")
must(route.includes('financialAuthorityMutated: false'), "route must declare read-only financial authority")
must(route.includes('piCreateExecuted: false'), "route must declare no Pi create")
must(route.includes('horizonSubmitExecuted: false'), "route must declare no Horizon submit")

console.log("FIN4_R4G_SUBMIT_CANDIDATE_PROBE=PASS select_only=true same_wallet=true refund_checked=true financial_authority_mutated=false pi_create=false horizon_submit=false")
