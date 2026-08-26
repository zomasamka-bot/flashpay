import { strict as assert } from "node:assert"
import { evaluateFinancialRecoverySettlementCreateReadBinding } from "../lib/financial-recovery-settlement-create-read-binding"
import type { FinancialRecoverySettlementCreateReadBindingInput } from "../lib/financial-recovery-settlement-create-read-binding"

const baseDecision: FinancialRecoverySettlementCreateReadBindingInput["decisionInput"] = {
  paymentId: "payment-1",
  currentState: "app_funds_confirmed",
  targetState: "settlement_created",
  reconciliationOutcome: "CONFIRMED_NONE",
  reconciliationSource: "PI_PAYMENT",
  targetMoneyMovementProof: null,
  targetPaymentIdPresent: false,
  targetTxidPresent: false,
  prerequisitesConfirmed: true,
  malformed: false,
  multipleCandidates: false,
  unknown: [],
  missing: [],
  conflicts: [],
}

type ReadEvidence = Extract<FinancialRecoverySettlementCreateReadBindingInput["read"], { outcome: "READ" }>

const baseU2ACandidate = {
  identifier: "pi-payment-1",
  metadata: { type: "a2u_settlement", paymentId: "payment-1" },
  direction: "user_to_app",
  amount: 2.5,
  user_uid: "payer-1",
  from_address: "user-address",
  to_address: "app-address",
  status: { developer_approved: true, transaction_verified: true, developer_completed: true },
  transaction: { txid: "u2a-tx-1" },
}

const baseRead: ReadEvidence = {
  outcome: "READ",
  u2a: { source: "PI_PAYMENT_GET", candidate: baseU2ACandidate },
  pi: { source: "PI_INCOMPLETE_SERVER_PAYMENTS", candidates: [] },
}

const baseInput: FinancialRecoverySettlementCreateReadBindingInput = {
  read: baseRead,
  },
  decisionInput: baseDecision,
  expected: { paymentId: "payment-1", piPaymentId: "pi-payment-1", u2aTxid: "u2a-tx-1", amount: 2.5, payerUid: "payer-1", merchantUid: "merchant-1" },
  queriedPaymentId: "payment-1",
  refundCheckpoint: { state: "absent" },
}

const clean = evaluateFinancialRecoverySettlementCreateReadBinding(baseInput)
assert.equal(clean.authorizesFinancialAction, false)
assert.equal(clean.outcome, "BOUND")
if (clean.outcome === "BOUND") {
  assert.equal(clean.result.authorizesFinancialAction, false)
  assert.equal(clean.result.outcome, "GATE_RESULT")
  if (clean.result.outcome === "GATE_RESULT") assert.deepEqual(clean.result.gate, { allow: true })
}
assert.equal(Object.prototype.hasOwnProperty.call(clean, "allow"), false)

const exact = evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, read: { ...baseRead, pi: { ...baseRead.pi, candidates: [{ identifier: "payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }] } } })
assert.equal(exact.authorizesFinancialAction, false)
assert.equal(exact.outcome, "BOUND")
if (exact.outcome === "BOUND" && exact.result.outcome === "GATE_RESULT") assert.deepEqual(exact.result.gate, { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })

assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, read: { ...baseInput.read, outcome: "INDETERMINATE", reason: "U2A_READ_FAILED" } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "READ_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, expected: { ...baseInput.expected, paymentId: " payment-1" } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "EXPECTED_INVALID" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, decisionInput: { ...baseDecision, paymentId: "other" } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "EXPECTED_INVALID" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, queriedPaymentId: "other" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "EXPECTED_INVALID" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, read: { ...baseRead, pi: { ...baseRead.pi, candidates: [{ metadata: { type: "refund", paymentId: "payment-1" } }] } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, read: { ...baseRead, pi: { ...baseRead.pi, candidates: [{ identifier: " payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }] } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreateReadBinding({ ...baseInput, read: { ...baseRead, u2a: { ...baseRead.u2a, candidate: { ...baseU2ACandidate, metadata: { type: "a2u_settlement", paymentId: "other" } } } } }), { authorizesFinancialAction: false, outcome: "BOUND", result: { authorizesFinancialAction: false, outcome: "PRE_GATE_BLOCKED", reason: "U2A_UNVERIFIED" } })
