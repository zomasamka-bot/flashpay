import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const read = (p) => readFileSync(p, "utf8")
const fail = (m) => { throw new Error(`FIN4_STEP10_RELEASE_HYGIENE_FAIL: ${m}`) }
const walk = (root) => {
  if (!existsSync(root)) return []
  const out=[]
  for (const name of readdirSync(root)) {
    const p=join(root,name); const st=statSync(p)
    if (st.isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}

for (const p of ["app/api/certification","app/api/test","app/api/debug","app/api/operations/f1-balance-integrity","app/api/operations/r10015-financial-snapshot"]) {
  if (existsSync(p)) fail(`temporary/dead runtime surface remains: ${p}`)
}

const runtimeFiles=[...walk("app"),...walk("lib"),...walk("components")].filter(p=>/\.(ts|tsx|js|mjs)$/.test(p))
const runtime=runtimeFiles.map(p=>`\n/* ${p} */\n${read(p)}`).join("\n")
for (const marker of [
  "FLASHPAY_FIN4_", "flashpay:cert:fin4", "FIN4_STAGE1_PREPARE",
  "F1_BALANCE_DIAGNOSTIC_ONCE_KEY", "F1_FORENSIC_ATTRIBUTION_ONCE_KEY", "F1_ROOT_CAUSE_CERT_ONCE_KEY",
  "F1_GUARDED_REPAIR_ONCE_KEY", "F1_FINAL_LEGACY_CLOSURE_ONCE_KEY", "F1_ORPHAN_FORENSIC_PROOF_ONCE_KEY",
  "F1_FINAL_ACCOUNTING_CERT_ONCE_KEY", "DR26_FINAL_ACCOUNTING_RECONCILIATION_ONCE_KEY",
  "temporary certification hook", "temporary forensic certification hook", "temporary root-cause certification hook",
]) if (runtime.includes(marker)) fail(`runtime residue remains: ${marker}`)

const transient=read("app/api/recovery/transient/route.ts")
if (transient.includes("repairF1LegacyCompletedCanonicalReceipts")) fail("historical F1 repair callable remains in recovery cron")

const accounting=read("app/api/operations/r1001-accounting-truth/route.ts")
if (!accounting.includes("Permanent owner-only operational accounting truth")) fail("R1001 operational classification missing")
if (!accounting.includes("verifyOwnerAuthorizationHeader")) fail("R1001 owner authorization missing")
if (accounting.includes("REMOVE AFTER CERTIFICATION")) fail("R1001 stale temporary marker remains")

const crashHook=runtime.includes("FLASHPAY_REFUND_CRASH_TEST")
if (!crashHook) fail("FIN-7 refund crash proof hook was removed prematurely")
const testnetHook=read("app/api/pi/complete/route.ts")
if (!testnetHook.includes("INTENTIONAL LIVE TESTNET CERTIFICATION HOOK — DO NOT REMOVE AS BUSINESS CLEANUP")) fail("intentional 0.10 Testnet hook missing")

console.log("FIN4_STEP10_RELEASE_HYGIENE=PASS")
console.log("temporary_runtime_surfaces=0")
console.log("fin4_runtime_residue=0")
console.log("historical_f1_cron_hooks=0")
console.log("required_future_proof_hooks=preserved")
