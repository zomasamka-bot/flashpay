import type { FinancialRecoveryState } from "./financial-recovery-state"
import type { EvidenceFact, EvidencedState } from "./financial-recovery-evidence"

export type FinancialRecoveryDecision =
  | "NO_ACTION"
  | "RESUME_NON_FINANCIAL"
  | "SAFE_FINANCIAL_RETRY"
  | "RECONCILE_FIRST"
  | "MANUAL_REVIEW"

export type EvidenceFactSet = readonly EvidenceFact[]

export type FinancialRecoveryReconciliationOutcome =
  | "NOT_ATTEMPTED"
  | "FOUND"
  | "CONFIRMED_NONE"
  | "INDETERMINATE"

export type FinancialRecoveryDecisionInput = {
  paymentId: string
  currentState: FinancialRecoveryState
  targetState: EvidencedState
  reconciliationOutcome: FinancialRecoveryReconciliationOutcome
  prerequisitesConfirmed: boolean
  targetPaymentIdPresent: boolean
  targetTxidPresent: boolean
  targetMoneyMoved: boolean
  malformed: boolean
  multipleCandidates: boolean
  unknown: EvidenceFactSet
  missing: EvidenceFactSet
  conflicts: EvidenceFactSet
}

export type FinancialRecoveryDecisionResult = {
  decision: FinancialRecoveryDecision
  reason: string
}
