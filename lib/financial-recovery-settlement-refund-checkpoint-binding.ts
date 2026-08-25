import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import type { PaymentRefundCheckpointLookup } from "./refund-checkpoint-store"
import { evaluateSettlementRefundCheckpointBarrier } from "./financial-recovery-settlement-refund-checkpoint-barrier"

export function bindSettlementRefundCheckpointToDecision(
  decisionInput: FinancialRecoveryDecisionInput,
  lookup: PaymentRefundCheckpointLookup,
) {
  const paymentId = decisionInput.paymentId
  if (paymentId.trim() === "" || paymentId !== paymentId.trim()) {
    return evaluateSettlementRefundCheckpointBarrier("uncertain")
  }
  if (lookup.state === "present" && lookup.checkpoint.paymentId !== paymentId) {
    return evaluateSettlementRefundCheckpointBarrier("uncertain")
  }
  return evaluateSettlementRefundCheckpointBarrier(lookup.state)
}
