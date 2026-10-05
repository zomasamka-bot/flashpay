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
  require("./verify-fin4-r4e-capability-model.ts")
  require("./verify-fin4-live-certification-harness.ts")
  require("./verify-fin4-live-certification-mutations.ts")
  require("./verify-fin4-r4g-submit-candidate-probe.ts")
  require("./verify-fin4-r4h-armed-readiness-gate.ts")
  require("./verify-fin4-r4i-pi-pretransaction-probe.ts")
  require("./verify-r4j-u2a-pretransaction-recovery.ts")
  require("./verify-r4j-u2a-pretransaction-recovery-mutations.ts")
  require("./verify-fin4-r4k-b-stage1-preparation-gate.ts")
  require("./verify-fin4-r4k-b-stage1-preparation-mutations.ts")
  require("./verify-fin4-r4l-qualified-candidate-probe.ts")
  require("./verify-fin4-r4l-qualified-candidate-mutations.ts")
  require("./verify-fin4-r4m-a-stage1-preparation-gate.ts")
  require("./verify-fin4-r4m-a-stage1-preparation-mutations.ts")
  require("./verify-fin4-r4n-stage1-ambiguity-probe.ts")
  require("./verify-fin4-r4n-stage1-ambiguity-mutations.ts")
  require("./verify-fin4-r4p-stage1-retirement.ts")
  require("./verify-fin4-r4p-stage1-retirement-mutations.ts")
  require("./verify-fin4-r4o-ongoing-stale-evidence.ts")
  require("./verify-fin4-r4p1-guarded-retirement.ts")
  require("./verify-fin4-r4q-stage1-failure-evidence.ts")
  require("./verify-fin4-r4r-foreign-ongoing-identity.ts")
  require("./verify-fin4-r4r-foreign-ongoing-identity-mutations.ts")
  require("./verify-financial-recovery-settlement-create-pi-binding.ts")
  require("./verify-financial-recovery-settlement-create-pre-gate.ts")
  require("./verify-financial-recovery-settlement-create-gate-binding.ts")
  require("./verify-financial-recovery-settlement-create-read-binding.ts")
  require("./verify-financial-recovery-settlement-exactly-once-gate.ts")
  require("./verify-financial-recovery-settlement-submit-replay.ts")
} finally {
  if (priorTsHandler) {
    require.extensions[".ts"] = priorTsHandler
  } else {
    delete require.extensions[".ts"]
  }
}

