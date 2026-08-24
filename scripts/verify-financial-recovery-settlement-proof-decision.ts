import { strict as assert } from "node:assert"
import { decideFinancialRecoveryWithSettlementProof } from "../lib/financial-recovery-settlement-proof-decision"
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

function assertBlocked(
  decision: FinancialRecoveryDecisionInput,
  proof: SettlementProofBindingResult,
  reason: "PROOF_UNVERIFIED" | "PAYMENT_ID_MISMATCH" | "TARGET_NOT_SETTLEMENT" | "PROOF_CONFLICT",
): void {
  const result = decideFinancialRecoveryWithSettlementProof(decision, proof)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "BLOCKED")
  if (result.outcome === "BLOCKED") assert.equal(result.reason, reason)
}

function assertDecision(
  decision: FinancialRecoveryDecisionInput,
  proof: SettlementProofBindingResult,
  expectedDecision: "MANUAL_REVIEW" | "RESUME_NON_FINANCIAL",
  expectedReason: "EVIDENCE_CONFLICT" | "MONEY_MOVED_RESUME_ONLY",
): void {
  const result = decideFinancialRecoveryWithSettlementProof(decision, proof)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "DECISION")
  if (result.outcome === "DECISION") {
    assert.equal(result.decision.decision, expectedDecision)
    assert.equal(result.decision.reason, expectedReason)
  }
}

assertBlocked(baseDecision, unverified, "PROOF_UNVERIFIED")
assertDecision(baseDecision, verified, "MANUAL_REVIEW", "EVIDENCE_CONFLICT")
assertDecision(
  {
    ...baseDecision,
    currentState: "settlement_created",
    targetState: "settlement_blockchain_confirmed",
    reconciliationOutcome: "FOUND",
    reconciliationSource: "HORIZON",
  },
  verified,
  "RESUME_NON_FINANCIAL",
  "MONEY_MOVED_RESUME_ONLY",
)
assertBlocked({ ...baseDecision, paymentId: "other" }, verified, "PAYMENT_ID_MISMATCH")
assertBlocked({ ...baseDecision, targetState: "refund_created" }, verified, "TARGET_NOT_SETTLEMENT")
assertBlocked({ ...baseDecision, targetMoneyMovementProof: "refund_horizon_tx_exact" }, verified, "PROOF_CONFLICT")
