import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(__dirname, "..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")
let checks = 0
const must = (ok: boolean, message: string) => {
  checks += 1
  if (!ok) throw new Error(`PRODUCTION_CALLGRAPH_BINDING=FAIL ${message}`)
}
const importBound = (source: string, symbol: string, modulePath: string) => {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`import\\s*\\{[^}]*\\b${escapedSymbol}\\b[^}]*\\}\\s*from\\s*["']${escapedPath}["']`)
  must(pattern.test(source), `missing import ${symbol} from ${modulePath}`)
}
const invoked = (source: string, symbol: string) => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  must(new RegExp(`\\b${escaped}\\s*\\(`).test(source), `missing invocation ${symbol}()`)
}
const staticEdge = (path: string, symbol: string, modulePath: string) => {
  const source = read(path)
  importBound(source, symbol, modulePath)
  invoked(source, symbol)
}

// Production entrypoints -> shared settlement execution authority.
staticEdge("app/api/pi/a2u/route.ts", "executeA2ULocked", "@/lib/a2u-locked-executor")
staticEdge("app/api/recovery/transient/route.ts", "executeA2URecovery", "@/lib/a2u-recovery-service")
staticEdge("app/api/recovery/transient/route.ts", "runAutomaticRefundPass", "@/lib/refund-auto-orchestrator")
staticEdge("app/api/recovery/[id]/route.ts", "executeA2URecovery", "@/lib/a2u-recovery-service")
staticEdge("lib/a2u-recovery-service.ts", "executeA2ULocked", "@/lib/a2u-locked-executor")
staticEdge("lib/a2u-locked-executor.ts", "executeA2U", "@/lib/a2u-executor")
staticEdge("lib/a2u-locked-executor.ts", "executeFinancialRecoverySettlementSubmitReplay", "@/lib/financial-recovery-settlement-submit-replay-orchestration")
staticEdge("lib/a2u-executor.ts", "executeFinancialRecoverySettlementSubmitReplay", "@/lib/financial-recovery-settlement-submit-replay-orchestration")
must(/\bsubmitTransaction\s*\(\s*transaction\s*\)/.test(read("lib/a2u-executor.ts")), "a2u executor missing Horizon transaction submit")

// Settlement replay orchestration -> actual evidence/read + pre-gate + authorization gate.
const replay = read("lib/financial-recovery-settlement-submit-replay-orchestration.ts")
importBound(replay, "readFinancialRecoverySettlementSubmitEvidence", "./financial-recovery-settlement-submit-read-orchestration")
invoked(replay, "readFinancialRecoverySettlementSubmitEvidence")
importBound(replay, "evaluateFinancialRecoverySettlementSubmitReplayPreGate", "./financial-recovery-settlement-submit-replay-pre-gate")
invoked(replay, "evaluateFinancialRecoverySettlementSubmitReplayPreGate")
importBound(replay, "evaluateFinancialRecoverySettlementSubmitReplayGate", "./financial-recovery-settlement-submit-replay-gate")
invoked(replay, "evaluateFinancialRecoverySettlementSubmitReplayGate")

// Refund production worker -> executor -> blockchain submit helper. Dynamic import is a real runtime edge.
staticEdge("lib/refund-auto-orchestrator.ts", "executeRefundNextStep", "@/lib/refund-executor")
const refundExec = read("lib/refund-executor.ts")
must(/import\s*\(\s*["']\.\/refund-blockchain-submit["']\s*\)/.test(refundExec), "refund executor detached from dynamic blockchain submit helper")
invoked(refundExec, "submitRefundBlockchainOnce")
const refundSubmit = read("lib/refund-blockchain-submit.ts")
importBound(refundSubmit, "authorizeRefundBlockchainSubmit", "./refund-checkpoint-store")
invoked(refundSubmit, "authorizeRefundBlockchainSubmit")
must(/\bserver\.submitTransaction\s*\(/.test(refundSubmit), "refund blockchain helper missing Horizon submit")

// Projection CAS authority must be imported and invoked by production recovery/financial executors.
staticEdge("app/api/recovery/transient/route.ts", "compareAndSwapPaymentProjection", "@/lib/payment-projection-cas")
staticEdge("lib/a2u-executor.ts", "compareAndSwapPaymentProjection", "@/lib/payment-projection-cas")
staticEdge("lib/refund-executor.ts", "compareAndSwapPaymentProjection", "./payment-projection-cas")

// This gate itself must be mandatory in the build verifier.
const runner = read("scripts/run-financial-recovery-build-verifier.mjs")
must(/require\(["']\.\/verify-production-callgraph-certifier-binding\.ts["']\)/.test(runner), "callgraph gate not mandatory in build verifier")

console.log(`PRODUCTION_CALLGRAPH_BINDING=PASS assertions=${checks} static_and_dynamic_imports=true invocations_bound=true model_claims_separated=true`)
