import type {
  FinancialRecoveryDecisionInput,
  FinancialRecoveryDecisionResult,
} from "./financial-recovery-decision"
import type {
  ExactlyOnceOperation,
  ExactlyOncePresenceState,
  ExactlyOnceReason,
} from "./financial-recovery-exactly-once-gate"

export type FinancialRecoveryOrchestrationInput = Readonly<{
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
