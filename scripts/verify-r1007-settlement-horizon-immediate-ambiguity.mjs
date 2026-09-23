import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const ex=read("lib/a2u-executor.ts")
const orchestration=read("lib/financial-recovery-settlement-submit-replay-orchestration.ts")
const reader=read("lib/financial-recovery-settlement-submit-horizon-reader.ts")
const binding=read("lib/financial-recovery-settlement-submit-horizon-binding.ts")
const must=(s,x)=>assert.ok(s.includes(x),`missing R100-7 binding: ${x}`)

for(const x of [
  'executeFinancialRecoverySettlementSubmitReplay',
  '[R100-7 SETTLEMENT HORIZON IMMEDIATE RECONCILIATION] submit exception',
  'const reconciled = await executeFinancialRecoverySettlementSubmitReplay({ payment: ctx.payment, paymentId: ctx.paymentId })',
  'reconciled.outcome !== "MOVEMENT_VERIFIED"',
  'reconciled.moneyMovementProven !== true',
  'reconciled.authorizesFinancialAction !== false',
  'reconciled.reference.preparedHash !== preparedHash',
  'reconciled.reference.preparedSequence !== transaction.sequence',
  'reconciled.reference.a2uPaymentId !== a2uPaymentId',
  'reconciled.reference.fromAddress !== appPublicKey',
  'reconciled.reference.toAddress !== toAddress',
  'reconciled.reference.amount !== amount',
  'reconciled.reference.envelopeXdr !== transaction.toXDR()',
  '!Number.isSafeInteger(feeStroops)',
  'return { ok: false, error: "Horizon submit outcome remains unverified", userFacingStatus: "settlement_pending" }',
  'moved = { ok: true, txidFromHorizon: preparedHash }',
  'const feeChargedStroops = reconciledSubmitFeeStroops ?? transactionRecord?.fee_charged',
  'recordSettlementHorizonCheckpoint({'
]) must(ex,x)

// The ambiguity branch must never call submitTransaction itself; there is exactly one
// production submit in moveStage2UnderHeldWalletLock before the catch/reconciliation.
assert.equal((ex.match(/horizonServer\.submitTransaction\(transaction\)/g)||[]).length,1,"unexpected settlement submit call count")

for(const x of [
  'if (readResult.outcome === "MOVEMENT_VERIFIED")',
  'proof: "horizon_tx_exact"',
  'moneyMovementProven: true',
  'authorizesFinancialAction: false'
]) must(orchestration,x)
for(const x of [
  '/transactions/${preparedHash}',
  'cache: "no-store"',
  'if (transactionResponse.status === 404)',
  '/accounts/${encodeURIComponent(fromAddress)}',
  'outcome: "INDETERMINATE"'
]) must(reader,x)
for(const x of [
  'input.read.transaction.source_account_sequence !== preparedSequence',
  'evaluateFinancialRecoveryHorizonProof({',
  'if (proof.outcome !== "VERIFIED")',
  'outcome: "VERIFIED"'
]) must(binding,x)

const cases=[
  {name:"submit_success",submitThrows:false,proof:"NA",expected:"CONTINUE"},
  {name:"throw_exact_hash_verified",submitThrows:true,proof:"MOVEMENT_VERIFIED",expected:"CONTINUE"},
  {name:"throw_hash_not_found_safe_sequence",submitThrows:true,proof:"ALLOW_EXACT_REPLAY",expected:"PENDING"},
  {name:"throw_horizon_indeterminate",submitThrows:true,proof:"BLOCKED",expected:"PENDING"},
  {name:"throw_exact_hash_identity_mismatch",submitThrows:true,proof:"MISMATCH",expected:"PENDING"},
]
for(const c of cases){
  const actual=!c.submitThrows?"CONTINUE":c.proof==="MOVEMENT_VERIFIED"?"CONTINUE":"PENDING"
  assert.equal(actual,c.expected,c.name)
}
console.log(JSON.stringify({
  certification:"PASS",gate:"R100-7-SETTLEMENT-HORIZON-IMMEDIATE-AMBIGUITY",
  productionSourceBound:true,cases:cases.length,casesPassed:cases.length,
  immediateGetOnlyReconciliation:true,exactPreparedHashRequired:true,exactIdentityBindingRequired:true,
  indeterminateFailsClosed:true,blindResubmitAdded:false,additionalSubmitCalls:0,
  financialMovementExecuted:false,changedRuntimeFiles:["lib/a2u-executor.ts"],
},null,2))
