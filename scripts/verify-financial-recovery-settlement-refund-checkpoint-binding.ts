import { strict as assert } from "node:assert"
import { bindSettlementRefundCheckpointToDecision } from "../lib/financial-recovery-settlement-refund-checkpoint-binding"
import type { FinancialRecoveryDecisionInput } from "../lib/financial-recovery-decision"
import type { RefundCheckpoint } from "../lib/refund-checkpoint-store"

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

const t = "2026-01-01T00:00:00Z"
const checkpoint: RefundCheckpoint = {
  refundId: "r",
  paymentId: "payment-1",
  idempotencyKey: "i",
  status: "pending",
  stage: "intent_created",
  payerUid: "p",
  payerUidVerifiedAt: t,
  amount: 2.5,
  currency: "π",
  sourcePaymentStatus: "settlement_failed",
  sourceSettlementState: "refund_pending",
  createdAt: t,
  updatedAt: t,
  attemptCount: 0,
}

assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "payment-1", { state: "absent" }), {
  authorizesFinancialAction: false,
  outcome: "NO_CHECKPOINT_EVIDENCE",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "payment-1", { state: "uncertain" }), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "payment-1", { state: "present", checkpoint }), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_EVIDENCE",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "", { state: "absent" }), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision({ ...baseDecision, paymentId: "" }, "payment-1", { state: "absent" }), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "other", { state: "absent" }), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})
assert.deepEqual(bindSettlementRefundCheckpointToDecision(baseDecision, "payment-1", {
  state: "present",
  checkpoint: { ...checkpoint, paymentId: "other" },
}), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})
