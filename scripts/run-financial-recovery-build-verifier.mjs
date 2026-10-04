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
