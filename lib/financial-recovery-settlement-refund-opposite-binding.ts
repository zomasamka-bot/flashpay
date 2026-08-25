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
