import type { SettlementRefundCheckpointBarrierResult } from "./financial-recovery-settlement-refund-checkpoint-barrier"
import type { RefundPiReconciliationOutcome } from "./refund-pi-reconciliation"
import type { RefundBlockchainEvidenceResult } from "./refund-blockchain-evidence"


export type FinancialRecoverySettlementRefundOppositeBindingInput = Readonly<{
  checkpoint: SettlementRefundCheckpointBarrierResult
  refundPiOutcome: RefundPiReconciliationOutcome
  refundBlockchainOutcome: RefundBlockchainEvidenceResult["outcome"] | null
}>

export type FinancialRecoverySettlementRefundOppositeBindingResult =
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "CLEAR"
      oppositePaymentId: "ABSENT"
      oppositeTxid: "ABSENT"
      oppositeMoneyMovement: "ABSENT"
    }>
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "BLOCKED"
      reason: "OPPOSITE_BRANCH_EVIDENCE" | "OPPOSITE_BRANCH_UNCERTAIN"
    }>

export function evaluateFinancialRecoverySettlementRefundOppositeBinding(
  input: FinancialRecoverySettlementRefundOppositeBindingInput,
): FinancialRecoverySettlementRefundOppositeBindingResult {
  if (
    (input.checkpoint.outcome === "BLOCKED" && input.checkpoint.reason === "OPPOSITE_BRANCH_EVIDENCE") ||
    input.refundPiOutcome === "FOUND" ||
    input.refundBlockchainOutcome === "VERIFIED_TX"
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" }
  }

  if (
    input.checkpoint.outcome === "BLOCKED" ||
    input.refundPiOutcome === "INDETERMINATE" ||
    input.refundBlockchainOutcome === "NO_TX" ||
    input.refundBlockchainOutcome === "INDETERMINATE"
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" }
  }

  if (
    input.checkpoint.outcome === "NO_CHECKPOINT_EVIDENCE" &&
    input.refundPiOutcome === "CONFIRMED_NONE" &&
    input.refundBlockchainOutcome === null
  ) {
    return {
      authorizesFinancialAction: false,
      outcome: "CLEAR",
      oppositePaymentId: "ABSENT",
      oppositeTxid: "ABSENT",
      oppositeMoneyMovement: "ABSENT",
    }
  }

  return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" }
}
