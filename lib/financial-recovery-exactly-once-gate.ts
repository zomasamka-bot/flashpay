import type { FinancialRecoveryDecisionResult } from "./financial-recovery-decision"

export type ExactlyOnceOperation =
  | "SETTLEMENT_CREATE"
  | "SETTLEMENT_SUBMIT"
  | "REFUND_CREATE"
  | "REFUND_SUBMIT"

export type ExactlyOnceReason =
  | "OPPOSITE_BRANCH_EVIDENCE"
  | "TARGET_REFERENCE_CONFLICT"
  | "TARGET_PAYMENT_REQUIRED"
  | "DECISION_NOT_SAFE"

export type ExactlyOnceGateInput = Readonly<{
  operation: ExactlyOnceOperation
  decision: FinancialRecoveryDecisionResult
  targetPaymentIdPresent: boolean
  targetTxidPresent: boolean
  targetMoneyMovementProven: boolean
  oppositePaymentIdPresent: boolean
  oppositeTxidPresent: boolean
  oppositeMoneyMovementProven: boolean
}>

export type ExactlyOnceGateResult =
  | Readonly<{ allow: true }>
  | Readonly<{ allow: false; reason: ExactlyOnceReason }>

export function evaluateFinancialRecoveryExactlyOnceGate(input: ExactlyOnceGateInput): ExactlyOnceGateResult {
  if (input.oppositePaymentIdPresent || input.oppositeTxidPresent || input.oppositeMoneyMovementProven) {
    return { allow: false, reason: "OPPOSITE_BRANCH_EVIDENCE" }
  }
  if (input.targetTxidPresent || input.targetMoneyMovementProven) {
    return { allow: false, reason: "TARGET_REFERENCE_CONFLICT" }
  }

  const isCreate = input.operation === "SETTLEMENT_CREATE" || input.operation === "REFUND_CREATE"
  if (isCreate && input.targetPaymentIdPresent) {
    return { allow: false, reason: "TARGET_REFERENCE_CONFLICT" }
  }
  if (!isCreate && !input.targetPaymentIdPresent) {
    return { allow: false, reason: "TARGET_PAYMENT_REQUIRED" }
  }

  if (
    input.decision.decision !== "SAFE_FINANCIAL_RETRY" ||
    (isCreate
      ? input.decision.reason !== "SAFE_CREATE_RETRY"
      : input.decision.reason !== "SAFE_SUBMIT_RETRY")
  ) {
    return { allow: false, reason: "DECISION_NOT_SAFE" }
  }

  return { allow: true }
}
