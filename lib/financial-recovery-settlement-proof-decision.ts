import { decideFinancialRecovery, type FinancialRecoveryDecisionInput, type FinancialRecoveryDecisionResult } from "./financial-recovery-decision"
import { bindSettlementProofToDecisionInput } from "./financial-recovery-settlement-decision-binding"
import type { SettlementProofBindingResult } from "./financial-recovery-settlement-proof-binding"

export type FinancialRecoverySettlementProofDecisionResult = Readonly<
  { authorizesFinancialAction: false } & (
    | { outcome: "DECISION"; decision: Exclude<FinancialRecoveryDecisionResult, { decision: "SAFE_FINANCIAL_RETRY" }> }
    | {
        outcome: "BLOCKED"
        reason:
          | "PROOF_UNVERIFIED"
          | "PAYMENT_ID_MISMATCH"
          | "TARGET_NOT_SETTLEMENT"
          | "PROOF_CONFLICT"
          | "UNEXPECTED_FINANCIAL_RETRY"
      }
  )
>

export function decideFinancialRecoveryWithSettlementProof(
  input: FinancialRecoveryDecisionInput,
  proof: SettlementProofBindingResult,
): FinancialRecoverySettlementProofDecisionResult {
  const bound = bindSettlementProofToDecisionInput(input, proof)
  if (bound.outcome === "BLOCKED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: bound.reason }
  }

  const decision = decideFinancialRecovery(bound.decisionInput)
  if (decision.decision === "SAFE_FINANCIAL_RETRY") {
    return {
      authorizesFinancialAction: false,
      outcome: "BLOCKED",
      reason: "UNEXPECTED_FINANCIAL_RETRY",
    }
  }
  return { authorizesFinancialAction: false, outcome: "DECISION", decision }
}
