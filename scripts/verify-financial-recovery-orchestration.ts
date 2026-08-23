import { strict as assert } from "node:assert"
import { orchestrateFinancialRecovery } from "../lib/financial-recovery-orchestration"

const base = Object.freeze({
  paymentId: "payment-verify-001",
  prerequisitesConfirmed: true,
  targetPaymentIdPresent: false,
  targetTxidPresent: false,
  targetMoneyMovementProof: null,
  malformed: false,
  multipleCandidates: false,
  unknown: [],
  missing: [],
  conflicts: [],
  reconciliationOutcome: "CONFIRMED_NONE",
  reconciliationSource: "PI_PAYMENT",
})

const settlementCreate = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_CREATE",
  decisionInput: {
    ...base,
    currentState: "app_funds_confirmed",
    targetState: "settlement_created",
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(settlementCreate, {
  outcome: "FINANCIAL_RETRY_ALLOWED",
  operation: "SETTLEMENT_CREATE",
  decision: { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_CREATE_RETRY" },
})

const refundCreate = orchestrateFinancialRecovery({
  operation: "REFUND_CREATE",
  decisionInput: {
    ...base,
    currentState: "refund_eligible",
    targetState: "refund_created",
    reconciliationSource: "PI_PAYMENT",
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(refundCreate, {
  outcome: "FINANCIAL_RETRY_ALLOWED",
  operation: "REFUND_CREATE",
  decision: { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_CREATE_RETRY" },
})

const settlementSubmit = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    targetPaymentIdPresent: true,
    reconciliationSource: "HORIZON",
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(settlementSubmit, {
  outcome: "FINANCIAL_RETRY_ALLOWED",
  operation: "SETTLEMENT_SUBMIT",
  decision: { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_SUBMIT_RETRY" },
})

const refundSubmit = orchestrateFinancialRecovery({
  operation: "REFUND_SUBMIT",
  decisionInput: {
    ...base,
    currentState: "refund_created",
    targetState: "refund_blockchain_confirmed",
    targetPaymentIdPresent: true,
    reconciliationSource: "HORIZON",
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(refundSubmit, {
  outcome: "FINANCIAL_RETRY_ALLOWED",
  operation: "REFUND_SUBMIT",
  decision: { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_SUBMIT_RETRY" },
})

const mismatch = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_CREATE",
  decisionInput: {
    ...base,
    currentState: "app_funds_confirmed",
    targetState: "settlement_blockchain_confirmed",
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(mismatch, {
  outcome: "GATE_BLOCKED",
  operation: "SETTLEMENT_CREATE",
  reason: "DECISION_TARGET_MISMATCH",
})

const presentAndUnknown = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, currentState: "app_funds_confirmed", targetState: "settlement_created" },
  oppositePaymentId: "PRESENT",
  oppositeTxid: "UNKNOWN",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(presentAndUnknown, { outcome: "GATE_BLOCKED", operation: "SETTLEMENT_CREATE", reason: "OPPOSITE_BRANCH_EVIDENCE" })

const unknown = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_CREATE",
  decisionInput: { ...base, currentState: "app_funds_confirmed", targetState: "settlement_created" },
  oppositePaymentId: "UNKNOWN",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(unknown, { outcome: "GATE_BLOCKED", operation: "SETTLEMENT_CREATE", reason: "OPPOSITE_BRANCH_UNCERTAIN" })

const notAttempted = orchestrateFinancialRecovery({
  operation: "SETTLEMENT_CREATE",
  decisionInput: {
    ...base,
    currentState: "app_funds_confirmed",
    targetState: "settlement_created",
    reconciliationOutcome: "NOT_ATTEMPTED",
    reconciliationSource: null,
  },
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})
assert.deepEqual(notAttempted, {
  outcome: "DECISION",
  decision: { decision: "RECONCILE_FIRST", reason: "RECONCILIATION_REQUIRED" },
})

console.log("financial recovery orchestration verification passed")
