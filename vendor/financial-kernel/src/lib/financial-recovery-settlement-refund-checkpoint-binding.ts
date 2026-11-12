import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import type { PaymentRefundCheckpointLookup } from "./refund-checkpoint-store"
import {
  evaluateSettlementRefundCheckpointBarrier,
  type SettlementRefundCheckpointBarrierResult,
} from "./financial-recovery-settlement-refund-checkpoint-barrier"

export function bindSettlementRefundCheckpointToDecision(
  decisionInput: FinancialRecoveryDecisionInput,
  queriedPaymentId: string,
  lookup: PaymentRefundCheckpointLookup,
): SettlementRefundCheckpointBarrierResult {
  const paymentId = decisionInput.paymentId
  if (
    paymentId.trim() === "" ||
    paymentId !== paymentId.trim() ||
    queriedPaymentId.trim() === "" ||
    queriedPaymentId !== queriedPaymentId.trim() ||
    queriedPaymentId !== paymentId
  ) {
    return evaluateSettlementRefundCheckpointBarrier("uncertain")
  }
  if (lookup.state === "present" && lookup.checkpoint.paymentId !== paymentId) {
    return evaluateSettlementRefundCheckpointBarrier("uncertain")
  }
  return evaluateSettlementRefundCheckpointBarrier(lookup.state)
}
