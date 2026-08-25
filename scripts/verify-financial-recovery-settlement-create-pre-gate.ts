import { strict as assert } from "node:assert"
import {
  evaluateFinancialRecoverySettlementCreatePreGate,
  type FinancialRecoverySettlementCreatePreGateInput,
} from "../lib/financial-recovery-settlement-create-pre-gate"

const baseDecision: FinancialRecoverySettlementCreatePreGateInput["decisionInput"] = {
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

const baseInput: FinancialRecoverySettlementCreatePreGateInput = {
  decisionInput: baseDecision,
  u2a: {
    source: "PI_PAYMENT_GET",
    candidate: {
      identifier: "pi-payment-1",
      metadata: { type: "a2u_settlement", paymentId: "payment-1" },
      direction: "user_to_app",
      amount: 2.5,
      user_uid: "payer-1",
      from_address: "user-address",
      to_address: "app-address",
      status: { developer_approved: true, transaction_verified: true, developer_completed: true },
      transaction: { txid: "u2a-tx-1" },
    },
    expected: {
      piPaymentId: "pi-payment-1",
      paymentId: "payment-1",
      u2aTxid: "u2a-tx-1",
      amount: 2.5,
      payerUid: "payer-1",
    },
  },
  pi: {
    source: "PI_INCOMPLETE_SERVER_PAYMENTS",
    expected: { branch: "SETTLEMENT", paymentId: "payment-1", amount: 2.5, merchantUid: "merchant-1" },
    candidates: [],
  },
  queriedPaymentId: "payment-1",
  refundCheckpoint: { state: "absent" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: null,
}

const baseResult = evaluateFinancialRecoverySettlementCreatePreGate(baseInput)
assert.equal(baseResult.authorizesFinancialAction, false)
assert.deepEqual(baseResult, {
  authorizesFinancialAction: false,
  outcome: "COMPOSED",
  decisionInput: { ...baseDecision, reconciliationOutcome: "CONFIRMED_NONE", reconciliationSource: "PI_PAYMENT", targetPaymentIdPresent: false },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})

const exactResult = evaluateFinancialRecoverySettlementCreatePreGate({
  ...baseInput,
  pi: {
    ...baseInput.pi,
    candidates: [{ identifier: "payment-1", metadata: { type: "a2u_settlement", paymentId: "payment-1" }, direction: "app_to_user", amount: 2.5, user_uid: "merchant-1", from_address: "app-address", to_address: "user-address" }],
  },
})
assert.equal(exactResult.authorizesFinancialAction, false)
assert.equal(exactResult.outcome, "COMPOSED")
if (exactResult.outcome === "COMPOSED") assert.deepEqual(exactResult.decisionInput, { ...baseDecision, reconciliationOutcome: "FOUND", reconciliationSource: "PI_PAYMENT", targetPaymentIdPresent: true })

assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, u2a: { ...baseInput.u2a, expected: { ...baseInput.u2a.expected, paymentId: " payment-1" } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "U2A_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, u2a: { ...baseInput.u2a, expected: { ...baseInput.u2a.expected, paymentId: "other" } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "U2A_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, u2a: { ...baseInput.u2a, expected: { ...baseInput.u2a.expected, amount: 3 } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "U2A_UNVERIFIED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, pi: { ...baseInput.pi, source: null } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_BINDING_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, queriedPaymentId: "other" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "REFUND_CHECKPOINT_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundCheckpoint: { state: "uncertain" } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "REFUND_CHECKPOINT_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundCheckpoint: { state: "present", checkpoint: { refundId: "r", paymentId: "other", idempotencyKey: "i", status: "pending", stage: "intent_created", payerUid: "p", payerUidVerifiedAt: "2026-01-01T00:00:00Z", amount: 2.5, currency: "π", sourcePaymentStatus: "settlement_failed", sourceSettlementState: "refund_pending", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", attemptCount: 0 } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "REFUND_CHECKPOINT_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundCheckpoint: { state: "present", checkpoint: { refundId: "r", paymentId: "payment-1", idempotencyKey: "i", status: "pending", stage: "intent_created", payerUid: "p", payerUidVerifiedAt: "2026-01-01T00:00:00Z", amount: 2.5, currency: "π", sourcePaymentStatus: "settlement_failed", sourceSettlementState: "refund_pending", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", attemptCount: 0 } } }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "REFUND_CHECKPOINT_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundPiOutcome: "FOUND" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundPiOutcome: "INDETERMINATE" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundBlockchainOutcome: "VERIFIED_TX" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_BLOCKED" })
assert.deepEqual(evaluateFinancialRecoverySettlementCreatePreGate({ ...baseInput, refundBlockchainOutcome: "NO_TX" }), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_BLOCKED" })
