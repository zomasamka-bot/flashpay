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
  require("./verify-financial-recovery-settlement-refund-checkpoint-binding.ts")
  require("./verify-financial-recovery-settlement-exactly-once-gate.ts")
} finally {
  if (priorTsHandler) {
    require.extensions[".ts"] = priorTsHandler
  } else {
    delete require.extensions[".ts"]
  }
}
