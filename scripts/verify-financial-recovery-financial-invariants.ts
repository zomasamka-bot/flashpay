const assert = require("node:assert").strict
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")

const sourcePath = path.resolve(__dirname, "../lib/financial-validation.ts")
const source = fs.readFileSync(sourcePath, "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText

const validationModule = new Module(sourcePath, module)
validationModule.filename = sourcePath
validationModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
validationModule._compile(compiled, sourcePath)

const { validateFinancialData } = validationModule.exports
assert.equal(typeof validateFinancialData, "function")

const canonical = {
  piPaymentId: "pi-proof",
  u2aTxid: "u2a-proof",
  a2uPaymentId: "a2u-proof",
  a2uTxid: "a2u-tx-proof",
  merchantId: "merchant-proof",
  merchantUid: "merchant-uid-proof",
  customerAmount: 2.5,
  merchantAmount: 2.5,
  horizonFeeCharged: 0.00001,
  appCommission: 0,
  appNetImpact: -0.00001
}

const accepted = validateFinancialData(canonical)
assert.equal(accepted.success, true)

const adversarial = [
  { ...canonical, appCommission: 0.1 },
  { ...canonical, merchantAmount: 2.4 },
  { ...canonical, horizonFeeCharged: -0.00001, appNetImpact: 0.00001 },
  { ...canonical, appNetImpact: 0 }
]

for (const payment of adversarial) {
  const result = validateFinancialData(payment)
  assert.equal(result.success, false)
}

console.log("FINANCIAL_INVARIANTS_CERTIFIER=PASS")
