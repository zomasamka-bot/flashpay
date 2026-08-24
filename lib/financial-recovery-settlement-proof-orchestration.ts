import { decideFinancialRecoveryWithSettlementProof, type FinancialRecoverySettlementProofDecisionResult } from "./financial-recovery-settlement-proof-decision"
import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import type { SettlementProofBindingResult } from "./financial-recovery-settlement-proof-binding"
import type { ExactlyOncePresenceState } from "./financial-recovery-exactly-once-gate"

export type FinancialRecoverySettlementProofOrchestrationInput = Readonly<{
  decisionInput: FinancialRecoveryDecisionInput
  proof: SettlementProofBindingResult
  oppositePaymentId: ExactlyOncePresenceState
  oppositeTxid: ExactlyOncePresenceState
  oppositeMoneyMovement: ExactlyOncePresenceState
}>

export type FinancialRecoverySettlementProofOrchestrationResult = Readonly<
  { authorizesFinancialAction: false } & (
    | {
        outcome: "DECISION"
        decision: Extract<FinancialRecoverySettlementProofDecisionResult, { outcome: "DECISION" }>["decision"]
      }
    | {
        outcome: "BLOCKED"
        reason:
          | Extract<FinancialRecoverySettlementProofDecisionResult, { outcome: "BLOCKED" }>["reason"]
          | "OPPOSITE_BRANCH_EVIDENCE"
          | "OPPOSITE_BRANCH_UNCERTAIN"
      }
  )
>

export function orchestrateFinancialRecoveryWithSettlementProof(
  input: FinancialRecoverySettlementProofOrchestrationInput,
): FinancialRecoverySettlementProofOrchestrationResult {
  if (
    input.oppositePaymentId === "PRESENT" ||
    input.oppositeTxid === "PRESENT" ||
    input.oppositeMoneyMovement === "PRESENT"
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" }
  }
  if (
    input.oppositePaymentId !== "ABSENT" ||
    input.oppositeTxid !== "ABSENT" ||
    input.oppositeMoneyMovement !== "ABSENT"
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" }
  }

  const result = decideFinancialRecoveryWithSettlementProof(input.decisionInput, input.proof)
  if (result.outcome === "DECISION") {
    return { authorizesFinancialAction: false, outcome: "DECISION", decision: result.decision }
  }
  return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: result.reason }
}
