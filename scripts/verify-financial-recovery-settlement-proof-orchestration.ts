import { strict as assert } from "node:assert"
import { orchestrateFinancialRecoveryWithSettlementProof } from "../lib/financial-recovery-settlement-proof-orchestration"
import type { FinancialRecoverySettlementProofOrchestrationInput } from "../lib/financial-recovery-settlement-proof-orchestration"
import type { FinancialRecoveryDecisionInput } from "../lib/financial-recovery-decision"
import type { SettlementProofBindingResult } from "../lib/financial-recovery-settlement-proof-binding"

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

const verified: Extract<SettlementProofBindingResult, { outcome: "VERIFIED" }> = {
  authorizesFinancialAction: false,
  outcome: "VERIFIED",
  proof: "horizon_tx_exact",
  moneyMovementProven: true,
  reference: {
    paymentId: "payment-1",
    merchantUid: "merchant-1",
    a2uPaymentId: "a2u-1",
    txid: "tx-1",
    fromAddress: "app-address",
    toAddress: "user-address",
    amount: 2.5,
  },
}

const unverified: Extract<SettlementProofBindingResult, { outcome: "INDETERMINATE" }> = {
  authorizesFinancialAction: false,
  outcome: "INDETERMINATE",
  reason: "A2U_PROOF_UNVERIFIED",
}

const baseInput: FinancialRecoverySettlementProofOrchestrationInput = {
  decisionInput: baseDecision,
  proof: verified,
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
}

function assertDecision(
  input: FinancialRecoverySettlementProofOrchestrationInput,
  decision: "MANUAL_REVIEW" | "RESUME_NON_FINANCIAL",
  reason: "EVIDENCE_CONFLICT" | "MONEY_MOVED_RESUME_ONLY",
): void {
  const result = orchestrateFinancialRecoveryWithSettlementProof(input)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "DECISION")
  if (result.outcome === "DECISION") {
    assert.equal(result.decision.decision, decision)
    assert.equal(result.decision.reason, reason)
  }
}

function assertBlocked(
  input: FinancialRecoverySettlementProofOrchestrationInput,
  reason: "PROOF_UNVERIFIED" | "PAYMENT_ID_MISMATCH" | "TARGET_NOT_SETTLEMENT" | "PROOF_CONFLICT" | "OPPOSITE_BRANCH_EVIDENCE" | "OPPOSITE_BRANCH_UNCERTAIN",
): void {
  const result = orchestrateFinancialRecoveryWithSettlementProof(input)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "BLOCKED")
  if (result.outcome === "BLOCKED") assert.equal(result.reason, reason)
}

assertDecision(
  {
    ...baseInput,
    decisionInput: {
      ...baseDecision,
      currentState: "settlement_created",
      targetState: "settlement_blockchain_confirmed",
      reconciliationOutcome: "FOUND",
      reconciliationSource: "HORIZON",
    },
  },
  "RESUME_NON_FINANCIAL",
  "MONEY_MOVED_RESUME_ONLY",
)
assertDecision(baseInput, "MANUAL_REVIEW", "EVIDENCE_CONFLICT")
assertBlocked({ ...baseInput, proof: unverified }, "PROOF_UNVERIFIED")
assertBlocked({ ...baseInput, decisionInput: { ...baseDecision, paymentId: "other" } }, "PAYMENT_ID_MISMATCH")
assertBlocked({ ...baseInput, decisionInput: { ...baseDecision, targetState: "refund_created" } }, "TARGET_NOT_SETTLEMENT")
assertBlocked({ ...baseInput, decisionInput: { ...baseDecision, targetMoneyMovementProof: "refund_horizon_tx_exact" } }, "PROOF_CONFLICT")

for (const field of ["oppositePaymentId", "oppositeTxid", "oppositeMoneyMovement"] as const) {
  const present: FinancialRecoverySettlementProofOrchestrationInput = {
    ...baseInput,
    oppositePaymentId: field === "oppositePaymentId" ? "PRESENT" : "ABSENT",
    oppositeTxid: field === "oppositeTxid" ? "PRESENT" : "ABSENT",
    oppositeMoneyMovement: field === "oppositeMoneyMovement" ? "PRESENT" : "ABSENT",
  }
  assertBlocked(present, "OPPOSITE_BRANCH_EVIDENCE")

  const unknown: FinancialRecoverySettlementProofOrchestrationInput = {
    ...baseInput,
    oppositePaymentId: field === "oppositePaymentId" ? "UNKNOWN" : "ABSENT",
    oppositeTxid: field === "oppositeTxid" ? "UNKNOWN" : "ABSENT",
    oppositeMoneyMovement: field === "oppositeMoneyMovement" ? "UNKNOWN" : "ABSENT",
  }
  assertBlocked(unknown, "OPPOSITE_BRANCH_UNCERTAIN")
}

assertBlocked(
  {
    ...baseInput,
    oppositePaymentId: "PRESENT",
    oppositeTxid: "UNKNOWN",
    oppositeMoneyMovement: "ABSENT",
  },
  "OPPOSITE_BRANCH_EVIDENCE",
)

assertBlocked(
  {
    ...baseInput,
    oppositePaymentId: "UNKNOWN",
    oppositeTxid: "PRESENT",
    oppositeMoneyMovement: "ABSENT",
  },
  "OPPOSITE_BRANCH_EVIDENCE",
)

assertBlocked(
  {
    ...baseInput,
    oppositePaymentId: "PRESENT",
    oppositeTxid: "ABSENT",
    oppositeMoneyMovement: "UNKNOWN",
  },
  "OPPOSITE_BRANCH_EVIDENCE",
)
