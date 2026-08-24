import { strict as assert } from "node:assert"
import {
  orchestrateFinancialRecoveryWithU2AProof,
  type FinancialRecoveryOrchestrationInput,
} from "../lib/financial-recovery-orchestration"
import type { U2AInput } from "../lib/financial-recovery-u2a-proof"

const expected: U2AInput["expected"] = {
  piPaymentId: "pi-payment-1",
  paymentId: "payment-1",
  u2aTxid: "u2a-tx-1",
  amount: 2.5,
  payerUid: "payer-1",
}

const candidate: U2AInput["candidate"] = {
  identifier: "pi-payment-1",
  metadata: { paymentId: "payment-1" },
  direction: "user_to_app",
  amount: 2.5,
  user_uid: "payer-1",
  status: {
    developer_approved: true,
    transaction_verified: true,
    developer_completed: true,
  },
  transaction: { txid: "u2a-tx-1" },
}

const decisionInput: FinancialRecoveryOrchestrationInput["decisionInput"] = {
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

const orchestration: FinancialRecoveryOrchestrationInput = {
  operation: "SETTLEMENT_CREATE",
  decisionInput,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
}

function input(
  orchestrationValue: FinancialRecoveryOrchestrationInput,
  u2aValue: U2AInput,
): { orchestration: FinancialRecoveryOrchestrationInput; u2a: U2AInput } {
  return { orchestration: orchestrationValue, u2a: u2aValue }
}

function assertAllowed(value: { orchestration: FinancialRecoveryOrchestrationInput; u2a: U2AInput }): void {
  const result = orchestrateFinancialRecoveryWithU2AProof(input(value.orchestration, value.u2a))
  assert.equal(result.outcome, "FINANCIAL_RETRY_ALLOWED")
  if (result.outcome === "FINANCIAL_RETRY_ALLOWED") {
    assert.equal(result.decision.decision, "SAFE_FINANCIAL_RETRY")
    assert.equal(result.decision.reason, "SAFE_CREATE_RETRY")
  }
}

function assertDecision(
  value: { orchestration: FinancialRecoveryOrchestrationInput; u2a: U2AInput },
  expected: { decision: "RECONCILE_FIRST"; reason: "PREREQUISITES_UNCONFIRMED" } | { decision: "MANUAL_REVIEW"; reason: "INVALID_INPUT" },
): void {
  const result = orchestrateFinancialRecoveryWithU2AProof(input(value.orchestration, value.u2a))
  assert.equal(result.outcome, "DECISION")
  if (result.outcome === "DECISION") {
    assert.equal(result.decision.decision, expected.decision)
    assert.equal(result.decision.reason, expected.reason)
  }
}

function assertBlocked(
  value: { orchestration: FinancialRecoveryOrchestrationInput; u2a: U2AInput },
): void {
  const result = orchestrateFinancialRecoveryWithU2AProof(input(value.orchestration, value.u2a))
  assert.equal(result.outcome, "GATE_BLOCKED")
  if (result.outcome === "GATE_BLOCKED") assert.equal(result.reason, "OPPOSITE_BRANCH_EVIDENCE")
}

const validU2A: U2AInput = { source: "PI_PAYMENT_GET", candidate, expected }
assertAllowed({ orchestration, u2a: validU2A })

assertDecision({
  orchestration: { ...orchestration, decisionInput: { ...decisionInput, prerequisitesConfirmed: false } },
  u2a: validU2A,
}, { decision: "RECONCILE_FIRST", reason: "PREREQUISITES_UNCONFIRMED" })

const mismatchedCandidate: U2AInput["candidate"] = {
  ...candidate,
  metadata: { paymentId: "other-payment" },
}
assertDecision({ orchestration, u2a: { source: "PI_PAYMENT_GET", candidate: mismatchedCandidate, expected } }, { decision: "MANUAL_REVIEW", reason: "INVALID_INPUT" })
assertDecision({ orchestration, u2a: { source: null, candidate, expected } }, { decision: "MANUAL_REVIEW", reason: "INVALID_INPUT" })
assertDecision({ orchestration, u2a: { source: "PI_PAYMENT_GET", candidate: {}, expected } }, { decision: "MANUAL_REVIEW", reason: "INVALID_INPUT" })

const oppositeFields: readonly ("oppositePaymentId" | "oppositeTxid" | "oppositeMoneyMovement")[] = [
  "oppositePaymentId",
  "oppositeTxid",
  "oppositeMoneyMovement",
]
for (const field of oppositeFields) {
  const opposite: FinancialRecoveryOrchestrationInput = {
    ...orchestration,
    oppositePaymentId: field === "oppositePaymentId" ? "PRESENT" : "ABSENT",
    oppositeTxid: field === "oppositeTxid" ? "PRESENT" : "ABSENT",
    oppositeMoneyMovement: field === "oppositeMoneyMovement" ? "PRESENT" : "ABSENT",
  }
  assertBlocked({ orchestration: opposite, u2a: validU2A })
}

assertAllowed({ orchestration, u2a: validU2A })

console.log("U2A bound orchestration verification passed")
