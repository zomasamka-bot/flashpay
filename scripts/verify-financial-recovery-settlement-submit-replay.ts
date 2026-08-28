import { strict as assert } from "node:assert"
import { classifyFinancialRecoverySettlementSubmitSequence } from "../lib/financial-recovery-settlement-submit-sequence-classifier"
import { evaluateFinancialRecoverySettlementSubmitReplayPreGate } from "../lib/financial-recovery-settlement-submit-replay-pre-gate"
import { evaluateFinancialRecoverySettlementSubmitReplayGate } from "../lib/financial-recovery-settlement-submit-replay-gate"

const reference = {
  envelopeXdr: "xdr",
  preparedHash: "a".repeat(64),
  preparedSequence: "42",
  a2uPaymentId: "a2u-1",
  fromAddress: "from",
  toAddress: "to",
  amount: 2.5,
}

const basePayment = {
  id: "payment-1",
  merchantUid: "merchant-1",
  payerUid: "payer-1",
  customerAmount: 2.5,
  merchantAmount: 2.5,
  status: "settlement_pending",
  a2uPaymentId: reference.a2uPaymentId,
  a2uFromAddress: reference.fromAddress,
  a2uToAddress: reference.toAddress,
  a2uPreparedEnvelopeXdr: reference.envelopeXdr,
  a2uPreparedTxHash: reference.preparedHash,
  a2uPreparedSequence: reference.preparedSequence,
}

const sequenceInput = (observedSourceSequence: string) => ({
  outcome: "UNRESOLVED" as const,
  reference,
  observedSourceSequence,
  moneyMovementProven: false as const,
  authorizesFinancialAction: false as const,
})

assert.equal(classifyFinancialRecoverySettlementSubmitSequence(sequenceInput("41")).outcome, "PREPARED_IS_NEXT")
assert.equal(classifyFinancialRecoverySettlementSubmitSequence(sequenceInput("42")).outcome, "SOURCE_AT_OR_PAST_PREPARED")
assert.equal(classifyFinancialRecoverySettlementSubmitSequence(sequenceInput("40")).outcome, "SOURCE_BEHIND_PREPARED_GAP")

const baseRead = { ...sequenceInput("41"), paymentId: "payment-1", merchantUid: "merchant-1" }
const basePreGateInput = {
  payment: basePayment,
  readResult: baseRead,
  oppositeRefund: { outcome: "CLEAR" as const },
  refundPiResult: {
    outcome: "CONFIRMED_NONE" as const,
    authorizesFinancialAction: false as const,
    reference: { paymentId: "payment-1", payerUid: "payer-1", amount: 2.5, a2uPaymentId: "a2u-1" },
  },
}

const eligible = evaluateFinancialRecoverySettlementSubmitReplayPreGate(basePreGateInput)
assert.equal(eligible.outcome, "ELIGIBLE_EXACT_REPLAY")
assert.equal(eligible.authorizesFinancialAction, false)

const mismatches = [
  ["id", { id: "other" }],
  ["merchantUid", { merchantUid: "other" }],
  ["a2uPaymentId", { a2uPaymentId: "other" }],
  ["from", { a2uFromAddress: "other" }],
  ["to", { a2uToAddress: "other" }],
  ["amount", { merchantAmount: 3 }],
  ["XDR", { a2uPreparedEnvelopeXdr: "other" }],
  ["hash", { a2uPreparedTxHash: "b".repeat(64) }],
  ["sequence", { a2uPreparedSequence: "43" }],
  ["status", { status: "failed" }],
  ["flag", { horizonSuccessFlag: true }],
  ["refund", { refundTxid: "refund" }],
  ["refund Pi", { piCompletionPending: true }],
] as const
for (const [, change] of mismatches) {
  const result = evaluateFinancialRecoverySettlementSubmitReplayPreGate({ ...basePreGateInput, payment: { ...basePayment, ...change } })
  assert.deepEqual(result, { outcome: "BLOCKED", reference: null, authorizesFinancialAction: false })
}
for (const change of [
  { paymentId: "other" },
  { payerUid: "other" },
  { amount: 3 },
  { a2uPaymentId: "other" },
]) {
  const result = evaluateFinancialRecoverySettlementSubmitReplayPreGate({ ...basePreGateInput, refundPiResult: { ...basePreGateInput.refundPiResult, reference: { ...basePreGateInput.refundPiResult.reference, ...change } } })
  assert.deepEqual(result, { outcome: "BLOCKED", reference: null, authorizesFinancialAction: false })
}

const gate = evaluateFinancialRecoverySettlementSubmitReplayGate(eligible)
assert.equal(gate.outcome, "ALLOW_EXACT_REPLAY")
assert.equal(gate.authorizesFinancialAction, true)
assert.equal(gate.mode, "EXACT_STORED_XDR_ONLY")
assert.equal(gate.moneyMovementProven, false)
assert.equal(gate.reference, eligible.reference)

for (const input of [
  { outcome: "BLOCKED" as const, reference: null, authorizesFinancialAction: false as const },
  { outcome: "ELIGIBLE_EXACT_REPLAY" as const, reference: null, authorizesFinancialAction: false as const },
]) {
  const result = evaluateFinancialRecoverySettlementSubmitReplayGate(input)
  assert.equal(result.outcome, "BLOCKED")
  assert.equal(result.authorizesFinancialAction, false)
}
