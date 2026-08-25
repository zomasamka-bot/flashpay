import type { RefundCheckpointReadOnly } from "./refund-checkpoint-store"

export type SettlementRefundCheckpointBarrierResult =
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "BLOCKED"
      reason: "OPPOSITE_BRANCH_EVIDENCE" | "OPPOSITE_BRANCH_UNCERTAIN"
    }>
  | Readonly<{
      authorizesFinancialAction: false
      outcome: "NO_CHECKPOINT_EVIDENCE"
    }>

export function evaluateSettlementRefundCheckpointBarrier(
  state: RefundCheckpointReadOnly["state"],
): SettlementRefundCheckpointBarrierResult {
  if (state === "present") {
    return {
      authorizesFinancialAction: false,
      outcome: "BLOCKED",
      reason: "OPPOSITE_BRANCH_EVIDENCE",
    }
  }
  if (state === "uncertain") {
    return {
      authorizesFinancialAction: false,
      outcome: "BLOCKED",
      reason: "OPPOSITE_BRANCH_UNCERTAIN",
    }
  }
  return {
    authorizesFinancialAction: false,
    outcome: "NO_CHECKPOINT_EVIDENCE",
  }
}
