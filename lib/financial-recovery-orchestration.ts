import {
  decideFinancialRecovery,
  type FinancialRecoveryDecisionInput,
  type FinancialRecoveryDecisionResult,
} from "./financial-recovery-decision"
import {
  evaluateFinancialRecoveryExactlyOnceGate,
  type ExactlyOnceOperation,
  type ExactlyOncePresenceState,
  type ExactlyOnceReason,
} from "./financial-recovery-exactly-once-gate"
import { evaluateFinancialRecoveryU2AProof, type U2AInput } from "./financial-recovery-u2a-proof"

export type FinancialRecoveryOrchestrationInput = Readonly<{
  operation: ExactlyOnceOperation
  decisionInput: FinancialRecoveryDecisionInput
  oppositePaymentId: ExactlyOncePresenceState
  oppositeTxid: ExactlyOncePresenceState
  oppositeMoneyMovement: ExactlyOncePresenceState
}>

export type FinancialRecoveryOrchestrationResult =
  | Readonly<{
      outcome: "DECISION"
      decision: Exclude<FinancialRecoveryDecisionResult, { decision: "SAFE_FINANCIAL_RETRY" }>
    }>
  | Readonly<{
      outcome: "FINANCIAL_RETRY_ALLOWED"
      operation: ExactlyOnceOperation
      decision: Extract<FinancialRecoveryDecisionResult, { decision: "SAFE_FINANCIAL_RETRY" }>
    }>
  | Readonly<{
      outcome: "GATE_BLOCKED"
      operation: ExactlyOnceOperation
      reason: ExactlyOnceReason
    }>

export function orchestrateFinancialRecovery(
  input: FinancialRecoveryOrchestrationInput,
): FinancialRecoveryOrchestrationResult {
  const decision = decideFinancialRecovery(input.decisionInput)
  if (decision.decision !== "SAFE_FINANCIAL_RETRY") {
    return { outcome: "DECISION", decision }
  }

  const gate = evaluateFinancialRecoveryExactlyOnceGate({
    operation: input.operation,
    decisionInput: input.decisionInput,
    oppositePaymentId: input.oppositePaymentId,
    oppositeTxid: input.oppositeTxid,
    oppositeMoneyMovement: input.oppositeMoneyMovement,
  })
  if (!gate.allow) {
    return { outcome: "GATE_BLOCKED", operation: input.operation, reason: gate.reason }
  }
  return { outcome: "FINANCIAL_RETRY_ALLOWED", operation: input.operation, decision }
}

export type U2ABoundFinancialRecoveryInput = Readonly<{
  orchestration: FinancialRecoveryOrchestrationInput
  u2a: U2AInput
}>

export function orchestrateFinancialRecoveryWithU2AProof(
  input: U2ABoundFinancialRecoveryInput,
): FinancialRecoveryOrchestrationResult {
  const proof = evaluateFinancialRecoveryU2AProof(input.u2a)
  const d = input.orchestration.decisionInput
  const bound = input.u2a.expected.paymentId === d.paymentId && proof.outcome === "VERIFIED"
  const decisionInput: FinancialRecoveryDecisionInput = {
    ...d,
    prerequisitesConfirmed: d.prerequisitesConfirmed && bound,
    malformed: d.malformed || !bound,
  }
  return orchestrateFinancialRecovery({ ...input.orchestration, decisionInput })
}
