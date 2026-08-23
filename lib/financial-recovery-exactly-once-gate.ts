import { decideFinancialRecovery, type FinancialRecoveryDecisionInput } from "./financial-recovery-decision"

export type ExactlyOnceOperation =
  | "SETTLEMENT_CREATE"
  | "SETTLEMENT_SUBMIT"
  | "REFUND_CREATE"
  | "REFUND_SUBMIT"

export type ExactlyOnceReason =
  | "OPPOSITE_BRANCH_EVIDENCE"
  | "TARGET_REFERENCE_CONFLICT"
  | "TARGET_PAYMENT_REQUIRED"
  | "DECISION_TARGET_MISMATCH"
  | "DECISION_NOT_SAFE"

export type ExactlyOnceGateInput = Readonly<{
  operation: ExactlyOnceOperation
  decisionInput: FinancialRecoveryDecisionInput
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
  const targetStateByOperation: Record<ExactlyOnceOperation, FinancialRecoveryDecisionInput["targetState"]> = {
    SETTLEMENT_CREATE: "settlement_created",
    SETTLEMENT_SUBMIT: "settlement_blockchain_confirmed",
    REFUND_CREATE: "refund_created",
    REFUND_SUBMIT: "refund_blockchain_confirmed",
  }
  if (input.decisionInput.targetState !== targetStateByOperation[input.operation]) {
    return { allow: false, reason: "DECISION_TARGET_MISMATCH" }
  }

  const decision = decideFinancialRecovery(input.decisionInput)
  if (input.decisionInput.targetTxidPresent || input.decisionInput.targetMoneyMovementProof !== null) {
    return { allow: false, reason: "TARGET_REFERENCE_CONFLICT" }
  }

  const isCreate = input.operation === "SETTLEMENT_CREATE" || input.operation === "REFUND_CREATE"
  if (isCreate && input.decisionInput.targetPaymentIdPresent) {
    return { allow: false, reason: "TARGET_REFERENCE_CONFLICT" }
  }
  if (!isCreate && !input.decisionInput.targetPaymentIdPresent) {
    return { allow: false, reason: "TARGET_PAYMENT_REQUIRED" }
  }

  if (
    decision.decision !== "SAFE_FINANCIAL_RETRY" ||
    (isCreate
      ? decision.reason !== "SAFE_CREATE_RETRY"
      : decision.reason !== "SAFE_SUBMIT_RETRY")
  ) {
    return { allow: false, reason: "DECISION_NOT_SAFE" }
  }

  return { allow: true }
}
