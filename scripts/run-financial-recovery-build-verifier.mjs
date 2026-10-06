import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const priorTsHandler = require.extensions[".ts"]

require.extensions[".ts"] = function registerTypeScript(module, filename) {
  const source = readFileSync(filename, "utf8")
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

try {
  require("./verify-financial-recovery-u2a-proof.ts")
  require("./verify-financial-recovery-a2u-proof.ts")
  require("./verify-financial-recovery-horizon-proof.ts")
  require("./verify-financial-recovery-settlement-decision-binding.ts")
  require("./verify-financial-recovery-settlement-proof-binding.ts")
  require("./verify-financial-recovery-settlement-proof-decision.ts")
  require("./verify-financial-recovery-settlement-opposite-evidence.ts")
  require("./verify-financial-recovery-settlement-proof-orchestration.ts")
  require("./verify-financial-recovery-settlement-refund-checkpoint-barrier.ts")
  require("./verify-financial-recovery-refund-completion-barrier.ts")
require("./verify-financial-recovery-financial-invariants.ts")
  require("./verify-payment-finality-predicate.ts")
  require("./verify-financial-recovery-crash-policy.ts")
  require("./verify-financial-recovery-settlement-refund-checkpoint-binding.ts")
  require("./verify-financial-recovery-settlement-refund-opposite-binding.ts")
  require("./verify-settlement-refund-xor-production-binding.ts")
  require("./verify-wallet-submit-boundary-production-binding.ts")
  require("./verify-redis-projection-cas-production-binding.ts")
  require("./verify-production-callgraph-certifier-binding.ts")
require("./verify-dr11-refund-race-ui-binding.ts")
  require("./verify-dr11-orphan-a2u-refund-recovery.ts")
  require("./verify-emergency-stuck-payment-rescue-safety.ts")
  require("./verify-plan-f-building-risk-reconcile-boundary.ts")
  require("./verify-plan-g-cross-boundary-abc.ts")
  require("./verify-plan-h-crash-policy-production-binding.ts")
  require("./verify-plan-i-p1-pi-approval-ambiguity.ts")
  require("./verify-plan-i-p2-p4-review-closure.ts")
  require("./verify-plan-i-p5-redis-authority-documentation.ts")
  require("./verify-plan-i-p6-redis-loss-current-sha.ts")
  require("./verify-plan-i-p7-same-wallet-cross-instance-concurrency.ts")
  require("./verify-r4j-u2a-pretransaction-recovery.ts")
  require("./verify-r4j-u2a-pretransaction-recovery-mutations.ts")
  require("./verify-fin4-r4p-stage1-retirement.ts")
  require("./verify-fin4-r4p-stage1-retirement-mutations.ts")
  require("./verify-fin4-r4r-foreign-ongoing-identity.ts")
  require("./verify-fin4-r4r-foreign-ongoing-identity-mutations.ts")
  require("./verify-fin4-r4s-foreign-ongoing-refund-containment.ts")
  require("./verify-fin4-r4s-foreign-ongoing-refund-containment-mutations.ts")
  require("./verify-financial-recovery-settlement-create-pi-binding.ts")
  require("./verify-financial-recovery-settlement-create-pre-gate.ts")
  require("./verify-financial-recovery-settlement-create-gate-binding.ts")
  require("./verify-financial-recovery-settlement-create-read-binding.ts")
  require("./verify-financial-recovery-settlement-exactly-once-gate.ts")
  require("./verify-financial-recovery-settlement-submit-replay.ts")
  require("./verify-fin4-step7-scaffold-removal-hygiene.mjs")
  require("./verify-fin4-step8-final-surface-hygiene.mjs")
  require("./verify-fin4-step14-final-evidence-and-hygiene.mjs")
  require("./verify-fin4-step10-release-hygiene.mjs")
} finally {
  if (priorTsHandler) {
    require.extensions[".ts"] = priorTsHandler
  } else {
    delete require.extensions[".ts"]
  }
}


await import('./verify-fin4-r4t1-refund-retirement-schema-order.mjs')
await import('./verify-fin4-r4t1-refund-retirement-schema-order-mutations.mjs')

await import('./verify-fin4-r4t2-canonical-horizon-evidence.mjs')
await import('./verify-fin4-r4t2-canonical-horizon-evidence-mutations.mjs')


await import('./verify-fin4-r4t4-automatic-refund-retirement-boundary.mjs')
await import('./verify-fin4-r4t4-automatic-refund-retirement-boundary-mutations.mjs')









await import('./verify-fin4-step5-r4t4-regression.mjs')
await import('./verify-fin4-step5-r4t4-regression-mutations.mjs')


await import('./verify-fin5-fresh-dispatch-precreate-guard.mjs')
