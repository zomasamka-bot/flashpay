import fs from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "..")
const route = fs.readFileSync(path.join(root, "app/api/certification/fin4-trigger/route.ts"), "utf8")
const financialFiles = [
  "lib/a2u-executor.ts", "lib/a2u-locked-executor.ts", "lib/db.ts",
  "lib/refund-blockchain-submit.ts", "lib/pi-wallet-submit-lock.ts", "lib/a2u-recovery-service.ts",
  "app/api/pi/complete/route.ts",
]
function must(condition: boolean, message: string) { if (!condition) throw new Error(`FIN4_R4H_VERIFY_FAIL: ${message}`) }
must(route.includes('evidence") === "armed-readiness"'), "read-only armed readiness endpoint missing")
must(route.includes('const readiness = await readArmedReadiness(runId)'), "launch must evaluate readiness")
must(route.indexOf('const readiness = await readArmedReadiness(runId)', route.indexOf('export async function POST')) < route.indexOf('fin4ClaimLaunchForArmedRun(runId)', route.indexOf('export async function POST')), "readiness must precede one-shot claim")
must(route.includes('allowed.has(a.classification)') && route.includes('allowed.has(b.classification)'), "both armed payments must be eligible")
must(route.includes('!a.movementPresent && !b.movementPresent'), "moved armed payment must fail closed")
must(route.includes('!a.refundActive && !b.refundActive'), "refund-owned armed payment must fail closed")
must(route.includes('financialAuthorityMutated: false') && route.includes('horizonSubmitExecuted: false'), "readiness must remain read-only")
must(!route.includes('server.submitTransaction'), "certification route must not submit Horizon")
must(!route.includes('api.minepi.com/v2/payments"') && !route.includes('method: "POST",\n      headers: { "Authorization": `Key'), "readiness must not create Pi payment")
for (const file of financialFiles) must(fs.existsSync(path.join(root,file)), `missing protected financial file ${file}`)
console.log(`FIN4_R4H_ARMED_READINESS_GATE=PASS protected_financial_files=${financialFiles.length} readiness_before_claim=true both_armed_exact=true movement_blocked=true refund_blocked=true financial_authority=false`)
