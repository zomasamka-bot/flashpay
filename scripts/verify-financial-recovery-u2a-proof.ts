import { strict as assert } from "node:assert"
import { evaluateFinancialRecoveryU2AProof, type U2AInput } from "../lib/financial-recovery-u2a-proof"

const expected: U2AInput["expected"] = {
  piPaymentId: "pi-payment-1",
  paymentId: "payment-1",
  u2aTxid: "tx-u2a-1",
  amount: 2.5,
  payerUid: "payer-1",
}

function candidate(uid: "user_uid" | "user.uid" | "both" = "user_uid") {
  const base = {
    identifier: expected.piPaymentId,
    metadata: { paymentId: expected.paymentId },
    direction: "user_to_app",
    amount: expected.amount,
    transaction: { txid: expected.u2aTxid },
    status: {
      developer_approved: true,
      transaction_verified: true,
      developer_completed: true,
      cancelled: false,
      user_cancelled: false,
    },
  }
  if (uid === "user.uid") return { ...base, user: { uid: expected.payerUid } }
  if (uid === "both") return { ...base, user_uid: expected.payerUid, user: { uid: expected.payerUid } }
  return { ...base, user_uid: expected.payerUid }
}

function input(candidateValue: unknown, expectedValue: U2AInput["expected"] = expected, source: "PI_PAYMENT_GET" | null = "PI_PAYMENT_GET"): U2AInput {
  return { source, candidate: candidateValue, expected: expectedValue }
}

function assertVerified(value: U2AInput) {
  const result = evaluateFinancialRecoveryU2AProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "VERIFIED")
}

function assertRejected(value: U2AInput, outcome: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH") {
  const result = evaluateFinancialRecoveryU2AProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "INDETERMINATE")
  if (result.outcome === "INDETERMINATE") assert.equal(result.reason, outcome)
}

assertVerified(input(candidate("user_uid")))
assertVerified(input(candidate("user.uid")))
assertVerified(input(candidate("both")))
assertRejected(input(candidate(), expected, null), "NON_AUTHORITATIVE_SOURCE")

for (const key of ["piPaymentId", "paymentId", "u2aTxid", "payerUid"] as const) {
  assertRejected(input(candidate(), { ...expected, [key]: "   " }), "INVALID_INPUT")
}
for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
  assertRejected(input(candidate(), { ...expected, amount }), "INVALID_INPUT")
}

const mismatches = [
  { identifier: "wrong", metadata: candidate().metadata },
  { identifier: expected.piPaymentId, metadata: { paymentId: "wrong" } },
  { direction: "app_to_user" },
  { amount: 3 },
  { transaction: { txid: "wrong" } },
  { status: { developer_approved: false, transaction_verified: true, developer_completed: true, cancelled: false, user_cancelled: false } },
  { status: { developer_approved: true, transaction_verified: false, developer_completed: true, cancelled: false, user_cancelled: false } },
  { status: { developer_approved: true, transaction_verified: true, developer_completed: false, cancelled: false, user_cancelled: false } },
  { status: { developer_approved: true, transaction_verified: true, developer_completed: true, cancelled: true, user_cancelled: false } },
  { status: { developer_approved: true, transaction_verified: true, developer_completed: true, cancelled: false, user_cancelled: true } },
  { user_uid: "wrong" },
  { user: { uid: "wrong" } },
  { user_uid: "payer-1", user: { uid: "other" } },
]
for (const mismatch of mismatches) assertRejected(input({ ...candidate(), ...mismatch }), "MALFORMED_OR_MISMATCH")

assertRejected(input({ ...candidate("user.uid"), user: { uid: "wrong" } }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...candidate("user.uid"), user: {} }), "MALFORMED_OR_MISMATCH")

for (const malformed of [
  [],
  { ...candidate(), metadata: [] },
  { ...candidate(), status: [] },
  { ...candidate(), transaction: [] },
]) assertRejected(input(malformed), "MALFORMED_OR_MISMATCH")

console.log("U2A proof verification passed")
