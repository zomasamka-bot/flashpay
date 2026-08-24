import { strict as assert } from "node:assert"
import { bindSettlementProofToDecisionInput } from "../lib/financial-recovery-settlement-decision-binding"
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

const bound = bindSettlementProofToDecisionInput(baseDecision, verified)
assert.equal(bound.authorizesFinancialAction, false)
assert.equal(bound.outcome, "BOUND")
if (bound.outcome === "BOUND") {
  assert.deepEqual(bound.decisionInput, {
    ...baseDecision,
    targetPaymentIdPresent: true,
    targetTxidPresent: true,
    targetMoneyMovementProof: "horizon_tx_exact",
  })
}

const boundWithProof = bindSettlementProofToDecisionInput(
  { ...baseDecision, targetMoneyMovementProof: "horizon_tx_exact" },
  verified,
)
assert.equal(boundWithProof.authorizesFinancialAction, false)
assert.equal(boundWithProof.outcome, "BOUND")
if (boundWithProof.outcome === "BOUND") {
  assert.deepEqual(boundWithProof.decisionInput, {
    ...baseDecision,
    targetMoneyMovementProof: "horizon_tx_exact",
    targetPaymentIdPresent: true,
    targetTxidPresent: true,
  })
}

function assertBlocked(
  decision: FinancialRecoveryDecisionInput,
  proof: SettlementProofBindingResult,
  reason: "PROOF_UNVERIFIED" | "PAYMENT_ID_MISMATCH" | "TARGET_NOT_SETTLEMENT" | "PROOF_CONFLICT",
): void {
  const result = bindSettlementProofToDecisionInput(decision, proof)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "BLOCKED")
  if (result.outcome === "BLOCKED") assert.equal(result.reason, reason)
}

assertBlocked(baseDecision, unverified, "PROOF_UNVERIFIED")
assertBlocked({ ...baseDecision, paymentId: "other" }, unverified, "PROOF_UNVERIFIED")
assertBlocked(baseDecision, { ...verified, reference: { ...verified.reference, paymentId: "other" } }, "PAYMENT_ID_MISMATCH")
assertBlocked({ ...baseDecision, paymentId: "other", targetState: "refund_created" }, verified, "PAYMENT_ID_MISMATCH")
assertBlocked({ ...baseDecision, targetState: "refund_created" }, verified, "TARGET_NOT_SETTLEMENT")
assertBlocked({ ...baseDecision, targetState: "refund_created", targetMoneyMovementProof: "refund_horizon_tx_exact" }, verified, "TARGET_NOT_SETTLEMENT")
assertBlocked({ ...baseDecision, targetMoneyMovementProof: "refund_horizon_tx_exact" }, verified, "PROOF_CONFLICT")
