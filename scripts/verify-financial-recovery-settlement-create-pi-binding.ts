import { strict as assert } from "node:assert"
import { bindSettlementCreatePiToDecision } from "../lib/financial-recovery-settlement-create-pi-binding"
import type { SettlementCreateBindingInput } from "../lib/financial-recovery-settlement-create-pi-binding"
import type { FinancialRecoveryDecisionInput } from "../lib/financial-recovery-decision"

const baseDecision: FinancialRecoveryDecisionInput = {
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

const base: Pick<SettlementCreateBindingInput["pi"], "source" | "expected"> = {
  source: "PI_INCOMPLETE_SERVER_PAYMENTS",
  expected: { branch: "SETTLEMENT", paymentId: "payment-1", amount: 2.5, merchantUid: "merchant-1" },
}

const empty = bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, candidates: [] } })
assert.equal(empty.authorizesFinancialAction, false)
assert.equal(empty.outcome, "BOUND")
if (empty.outcome === "BOUND") assert.deepEqual(empty.decisionInput, { ...baseDecision, reconciliationOutcome: "CONFIRMED_NONE", reconciliationSource: "PI_PAYMENT", targetPaymentIdPresent: false })

const exact = bindSettlementCreatePiToDecision({
  decisionInput: baseDecision,
  pi: {
    ...base,
    candidates: [{ identifier: "payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }],
  },
})
assert.equal(exact.authorizesFinancialAction, false)
assert.equal(exact.outcome, "BOUND")
if (exact.outcome === "BOUND") assert.deepEqual(exact.decisionInput, { ...baseDecision, reconciliationOutcome: "FOUND", reconciliationSource: "PI_PAYMENT", targetPaymentIdPresent: true })

assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, source: null, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, candidates: null } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: { ...baseDecision, paymentId: "" }, pi: { ...base, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, expected: { ...base.expected, paymentId: "" }, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: { ...baseDecision, paymentId: " payment-1" }, pi: { ...base, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, candidates: [{}] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, expected: { ...base.expected, paymentId: " payment-1" }, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: { ...baseDecision, paymentId: "other" }, pi: { ...base, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: { ...baseDecision, targetState: "refund_created" }, pi: { ...base, candidates: [] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "TARGET_STATE_MISMATCH" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, candidates: [{ metadata: { type: "refund", paymentId: "payment-1" } }] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
assert.deepEqual(bindSettlementCreatePiToDecision({ decisionInput: baseDecision, pi: { ...base, candidates: [{ identifier: "payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }, { identifier: "payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }] } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_EVIDENCE_UNVERIFIED" })
