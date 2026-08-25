import { evaluateFinancialRecoveryU2AProof, type U2AInput } from "./financial-recovery-u2a-proof"
import type { FinancialRecoveryDecisionInput } from "./financial-recovery-decision"
import { bindSettlementCreatePiToDecision, type SettlementCreateBindingInput } from "./financial-recovery-settlement-create-pi-binding"
import { bindSettlementRefundCheckpointToDecision } from "./financial-recovery-settlement-refund-checkpoint-binding"
import {
  evaluateFinancialRecoverySettlementRefundOppositeBinding,
  type FinancialRecoverySettlementRefundOppositeBindingInput,
} from "./financial-recovery-settlement-refund-opposite-binding"
import type { PaymentRefundCheckpointLookup } from "./refund-checkpoint-store"
import type { RefundPiReconciliationOutcome } from "./refund-pi-reconciliation"
import type { RefundBlockchainEvidenceResult } from "./refund-blockchain-evidence"

export type FinancialRecoverySettlementCreatePreGateInput = Readonly<{
  decisionInput: FinancialRecoveryDecisionInput
  u2a: U2AInput
  pi: SettlementCreateBindingInput["pi"]
  queriedPaymentId: string
  refundCheckpoint: PaymentRefundCheckpointLookup
  refundPiOutcome: RefundPiReconciliationOutcome
  refundBlockchainOutcome: RefundBlockchainEvidenceResult["outcome"] | null
}>

export type FinancialRecoverySettlementCreatePreGateResult = Readonly<{
  authorizesFinancialAction: false
}> &
  (
    | Readonly<{
        outcome: "COMPOSED"
        decisionInput: FinancialRecoveryDecisionInput
        oppositePaymentId: "ABSENT"
        oppositeTxid: "ABSENT"
        oppositeMoneyMovement: "ABSENT"
      }>
    | Readonly<{
        outcome: "BLOCKED"
        reason:
          | "U2A_UNVERIFIED"
          | "PI_BINDING_BLOCKED"
          | "REFUND_CHECKPOINT_BLOCKED"
          | "OPPOSITE_BRANCH_BLOCKED"
      }>
  )

export function evaluateFinancialRecoverySettlementCreatePreGate(
  input: FinancialRecoverySettlementCreatePreGateInput,
): FinancialRecoverySettlementCreatePreGateResult {
  const u2aProof = evaluateFinancialRecoveryU2AProof(input.u2a)
  if (
    u2aProof.outcome !== "VERIFIED" ||
    input.u2a.expected.paymentId !== input.u2a.expected.paymentId.trim() ||
    input.u2a.expected.paymentId !== input.decisionInput.paymentId ||
    input.u2a.expected.amount !== input.pi.expected.amount
  ) {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "U2A_UNVERIFIED" }
  }

  const piBinding = bindSettlementCreatePiToDecision({
    decisionInput: input.decisionInput,
    pi: input.pi,
  })
  if (piBinding.outcome === "BLOCKED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "PI_BINDING_BLOCKED" }
  }

  const checkpoint = bindSettlementRefundCheckpointToDecision(
    piBinding.decisionInput,
    input.queriedPaymentId,
    input.refundCheckpoint,
  )
  if (checkpoint.outcome === "BLOCKED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "REFUND_CHECKPOINT_BLOCKED" }
  }

  const opposite = evaluateFinancialRecoverySettlementRefundOppositeBinding({
    checkpoint,
    refundPiOutcome: input.refundPiOutcome,
    refundBlockchainOutcome: input.refundBlockchainOutcome,
  } satisfies FinancialRecoverySettlementRefundOppositeBindingInput)
  if (opposite.outcome === "BLOCKED") {
    return { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_BLOCKED" }
  }

  return {
    authorizesFinancialAction: false,
    outcome: "COMPOSED",
    decisionInput: piBinding.decisionInput,
    oppositePaymentId: "ABSENT",
    oppositeTxid: "ABSENT",
    oppositeMoneyMovement: "ABSENT",
  }
}
