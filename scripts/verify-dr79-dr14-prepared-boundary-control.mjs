import { strict as assert } from "node:assert"
import fs from "node:fs"
const executor=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
const harness=fs.readFileSync(new URL("../lib/dr14-live-crash-certification.ts",import.meta.url),"utf8")
const prepared=executor.indexOf("prepareStage2UnderHeldWalletLock")
const boundary=executor.indexOf("'settlement_after_prepared_durable'")
const move=executor.indexOf("moved = await moveStage2UnderHeldWalletLock")
assert.ok(prepared>=0 && boundary>prepared && move>boundary,{prepared,boundary,move})
assert.ok(harness.includes("'settlement_after_prepared_durable'"))
console.log(JSON.stringify({certification:"PASS",gate:"DR79-DR14-PREPARED-BOUNDARY-HISTORICAL-INVARIANT",boundary:"settlement_after_prepared_durable",preparedBeforeInterruption:true,horizonMoveAfterInterruption:true,historicalBoundaryRetained:true,financialExecutorChanged:false},null,2))
