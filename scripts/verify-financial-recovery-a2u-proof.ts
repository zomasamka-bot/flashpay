import { strict as assert } from "node:assert"
import {
  evaluateFinancialRecoveryA2UProof,
  type A2UProofInput,
} from "../lib/financial-recovery-a2u-proof"

const expected: A2UProofInput["expected"] = {
  a2uPaymentId: "pi-a2u-1",
  paymentId: "payment-1",
  amount: 2.5,
  merchantUid: "merchant-1",
  appAddress: "app-address-1",
}

const baseMetadata: Readonly<Record<string, unknown>> = {
  type: "a2u_settlement",
  paymentId: expected.paymentId,
}
const baseStatus: Readonly<Record<string, unknown>> = {
  developer_approved: true,
  transaction_verified: true,
  developer_completed: true,
}
const baseCandidate: Readonly<Record<string, unknown>> = {
  identifier: expected.a2uPaymentId,
  metadata: baseMetadata,
  direction: "app_to_user",
  amount: expected.amount,
  user_uid: expected.merchantUid,
  from_address: expected.appAddress,
  to_address: "user-address-1",
  status: baseStatus,
}

function input(
  candidate: unknown,
  expectedValue: A2UProofInput["expected"] = expected,
  source: A2UProofInput["source"] = "PI_PAYMENT_GET",
): A2UProofInput {
  return { source, candidate, expected: expectedValue }
}

function assertVerified(value: A2UProofInput, txid: string | null): void {
  const result = evaluateFinancialRecoveryA2UProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "VERIFIED")
  if (result.outcome === "VERIFIED") {
    assert.deepEqual(result.reference, {
      a2uPaymentId: expected.a2uPaymentId,
      paymentId: expected.paymentId,
      merchantUid: expected.merchantUid,
      amount: expected.amount,
      fromAddress: expected.appAddress,
      toAddress: "user-address-1",
      txid,
    })
    assert.equal(result.moneyMovementProven, false)
  }
}

function assertRejected(
  value: A2UProofInput,
  reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH",
): void {
  const result = evaluateFinancialRecoveryA2UProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "INDETERMINATE")
  if (result.outcome === "INDETERMINATE") assert.equal(result.reason, reason)
}

assertVerified(input({ ...baseCandidate }), null)
assertVerified(input({ ...baseCandidate, status: null }), null)
assertVerified(input({ ...baseCandidate, status: { developer_approved: false, transaction_verified: false, developer_completed: false } }), null)
assertVerified(input({ ...baseCandidate, transaction: null }), null)
assertVerified(input({ ...baseCandidate, transaction: { txid: "tx-a2u-1" } }), "tx-a2u-1")

assertRejected(input({ ...baseCandidate }, expected, null), "NON_AUTHORITATIVE_SOURCE")

for (const key of ["a2uPaymentId", "paymentId", "merchantUid", "appAddress"] as const) {
  assertRejected(input({ ...baseCandidate }, { ...expected, [key]: "" }), "INVALID_INPUT")
}
for (const amount of [NaN, Infinity, 0, -1]) {
  assertRejected(input({ ...baseCandidate }, { ...expected, amount }), "INVALID_INPUT")
}

assertRejected(input(null), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, metadata: null }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, status: [] }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, transaction: "bad" }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, to_address: "" }), "MALFORMED_OR_MISMATCH")

for (const field of ["identifier", "direction", "amount", "user_uid", "from_address"] as const) {
  assertRejected(input({ ...baseCandidate, [field]: field === "amount" ? 1 : "wrong" }), "MALFORMED_OR_MISMATCH")
}
assertRejected(input({ ...baseCandidate, metadata: { ...baseMetadata, type: "wrong" } }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, metadata: { ...baseMetadata, paymentId: "wrong" } }), "MALFORMED_OR_MISMATCH")

for (const flag of ["cancelled", "user_cancelled"] as const) {
  assertRejected(input({ ...baseCandidate, status: { ...baseStatus, [flag]: true } }), "MALFORMED_OR_MISMATCH")
  assertRejected(input({ ...baseCandidate, status: { ...baseStatus, [flag]: "false" } }), "MALFORMED_OR_MISMATCH")
}

assertRejected(input({ ...baseCandidate, transaction: { txid: "" } }), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseCandidate, transaction: { txid: 42 } }), "MALFORMED_OR_MISMATCH")
