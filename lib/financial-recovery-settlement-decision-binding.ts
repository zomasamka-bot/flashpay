import type { SettlementProofBindingResult } from "./financial-recovery-settlement-proof-binding"
import { FINANCIAL_RECOVERY_TARGET_RULES, type FinancialRecoveryDecisionInput } from "./financial-recovery-decision"

export type FinancialRecoverySettlementDecisionBindingResult = Readonly<
  { authorizesFinancialAction: false } & (
    | { outcome: "BOUND"; decisionInput: FinancialRecoveryDecisionInput }
    | { outcome: "BLOCKED"; reason: "PROOF_UNVERIFIED" | "PAYMENT_ID_MISMATCH" | "TARGET_NOT_SETTLEMENT" | "PROOF_CONFLICT" }
  )
>

export function bindSettlementProofToDecisionInput(
  decisionInput: FinancialRecoveryDecisionInput,
  proof: SettlementProofBindingResult,
): FinancialRecoverySettlementDecisionBindingResult {
  if (proof.outcome !== "VERIFIED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PROOF_UNVERIFIED" }
  }
  if (proof.reference.paymentId !== decisionInput.paymentId) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PAYMENT_ID_MISMATCH" }
  }
  if (FINANCIAL_RECOVERY_TARGET_RULES[decisionInput.targetState].branch !== "SETTLEMENT") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "TARGET_NOT_SETTLEMENT" }
  }
  if (
    decisionInput.targetMoneyMovementProof !== null &&
    decisionInput.targetMoneyMovementProof !== "horizon_tx_exact"
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PROOF_CONFLICT" }
  }
  return {
    authorizesFinancialAction: false,
    outcome: "BOUND",
    decisionInput: {
      ...decisionInput,
      targetPaymentIdPresent: true,
      targetTxidPresent: true,
      targetMoneyMovementProof: "horizon_tx_exact",
    },
  }
}
