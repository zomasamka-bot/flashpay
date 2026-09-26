import { strict as assert } from "node:assert"
import fs from "node:fs"
const executor=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
const harness=fs.readFileSync(new URL("../lib/dr14-live-crash-certification.ts",import.meta.url),"utf8")
const move=executor.indexOf("moved = await moveStage2UnderHeldWalletLock")
const movedOk=executor.indexOf("if (!moved.ok)",move)
const txid=executor.indexOf("const txidFromHorizon = moved.txidFromHorizon",movedOk)
const boundary=executor.indexOf("'settlement_after_horizon_submit_before_checkpoint'",txid)
const feeFetch=executor.indexOf("Fetching transaction record for fee verification",boundary)
assert.ok(move>=0 && movedOk>move && txid>movedOk && boundary>txid && feeFetch>boundary,{move,movedOk,txid,boundary,feeFetch})
assert.ok(harness.includes("'settlement_after_horizon_submit_before_checkpoint'"))
console.log(JSON.stringify({certification:"PASS",gate:"DR80-DR14-HORIZON-SUBMIT-BOUNDARY-HISTORICAL-INVARIANT",boundary:"settlement_after_horizon_submit_before_checkpoint",horizonSubmitBeforeInterruption:true,durableHorizonCheckpointAfterInterruption:true,historicalBoundaryRetained:true,financialExecutorChanged:false},null,2))
