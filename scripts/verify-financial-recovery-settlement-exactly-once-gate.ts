import { strict as assert } from "node:assert"
import { evaluateFinancialRecoveryExactlyOnceGate } from "../lib/financial-recovery-exactly-once-gate"
import type { FinancialRecoveryDecisionInput } from "../lib/financial-recovery-decision"
import type { ExactlyOncePresenceState } from "../lib/financial-recovery-exactly-once-gate"

const base: FinancialRecoveryDecisionInput = {
  paymentId: "payment-1",
  currentState: "app_funds_confirmed",
  targetState: "settlement_created",
  reconciliationOutcome: "CONFIRMED_NONE",
  reconciliationSource: "PI_PAYMENT",
  prerequisitesConfirmed: true,
  targetPaymentIdPresent: false,
  targetTxidPresent: false,
  targetMoneyMovementProof: null,
  malformed: false,
  multipleCandidates: false,
  unknown: [],
  missing: [],
  conflicts: [],
}

const absent: Readonly<{
  oppositePaymentId: ExactlyOncePresenceState
  oppositeTxid: ExactlyOncePresenceState
  oppositeMoneyMovement: ExactlyOncePresenceState
}> = {
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
}

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  ...absent,
}), { allow: true })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    reconciliationOutcome: "CONFIRMED_NONE",
    reconciliationSource: "HORIZON",
    targetPaymentIdPresent: true,
  },
  ...absent,
}), { allow: true })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, targetState: "refund_created" },
  ...absent,
}), { allow: false, reason: "DECISION_TARGET_MISMATCH" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, currentState: "settlement_created" },
  ...absent,
}), { allow: false, reason: "DECISION_NOT_SAFE" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "PRESENT",
  oppositeTxid: "UNKNOWN",
  oppositeMoneyMovement: "ABSENT",
}), { allow: false, reason: "OPPOSITE_BRANCH_EVIDENCE" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "UNKNOWN",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
}), { allow: false, reason: "OPPOSITE_BRANCH_UNCERTAIN" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "PRESENT",
  oppositeMoneyMovement: "ABSENT",
}), { allow: false, reason: "OPPOSITE_BRANCH_EVIDENCE" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "UNKNOWN",
  oppositeMoneyMovement: "ABSENT",
}), { allow: false, reason: "OPPOSITE_BRANCH_UNCERTAIN" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "PRESENT",
}), { allow: false, reason: "OPPOSITE_BRANCH_EVIDENCE" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: base,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "UNKNOWN",
}), { allow: false, reason: "OPPOSITE_BRANCH_UNCERTAIN" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, targetPaymentIdPresent: true },
  ...absent,
}), { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, targetTxidPresent: true },
  ...absent,
}), { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, targetMoneyMovementProof: "horizon_tx_exact" },
  ...absent,
}), { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    reconciliationOutcome: "CONFIRMED_NONE",
    reconciliationSource: "HORIZON",
    targetPaymentIdPresent: false,
  },
  ...absent,
}), { allow: false, reason: "TARGET_PAYMENT_REQUIRED" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    reconciliationOutcome: "CONFIRMED_NONE",
    reconciliationSource: "HORIZON",
    targetPaymentIdPresent: true,
    targetTxidPresent: true,
  },
  ...absent,
}), { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    reconciliationOutcome: "CONFIRMED_NONE",
    reconciliationSource: "HORIZON",
    targetPaymentIdPresent: true,
    targetMoneyMovementProof: "horizon_tx_exact",
  },
  ...absent,
}), { allow: false, reason: "TARGET_REFERENCE_CONFLICT" })

assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, malformed: true },
  ...absent,
}), { allow: false, reason: "DECISION_NOT_SAFE" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, prerequisitesConfirmed: false },
  ...absent,
}), { allow: false, reason: "DECISION_NOT_SAFE" })
assert.deepEqual(evaluateFinancialRecoveryExactlyOnceGate({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, reconciliationOutcome: "NOT_ATTEMPTED", reconciliationSource: null },
  ...absent,
}), { allow: false, reason: "DECISION_NOT_SAFE" })
