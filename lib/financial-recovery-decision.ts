import type { FinancialRecoveryState } from "./financial-recovery-state"
import type { EvidenceFact, EvidencedState } from "./financial-recovery-evidence"

export type FinancialRecoveryDecision =
  | "NO_ACTION"
  | "RESUME_NON_FINANCIAL"
  | "SAFE_FINANCIAL_RETRY"
  | "RECONCILE_FIRST"
  | "MANUAL_REVIEW"

export type EvidenceFactSet = readonly EvidenceFact[]

export type FinancialRecoveryBranch = "COMMON" | "SETTLEMENT" | "REFUND"
export type FinancialRecoveryTargetKind = "NON_FINANCIAL" | "FINANCIAL_CREATE" | "FINANCIAL_SUBMIT"
export type FinancialRecoveryOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type FinancialRecoveryTargetRule = {
  readonly branch: FinancialRecoveryBranch
  readonly order: FinancialRecoveryOrder
  readonly kind: FinancialRecoveryTargetKind
}

export const FINANCIAL_RECOVERY_TARGET_RULES: Readonly<Record<EvidencedState, FinancialRecoveryTargetRule>> = {
  u2a_verified: { branch: "COMMON", order: 1, kind: "NON_FINANCIAL" },
  app_funds_confirmed: { branch: "COMMON", order: 2, kind: "NON_FINANCIAL" },
  settlement_created: { branch: "SETTLEMENT", order: 3, kind: "FINANCIAL_CREATE" },
  settlement_blockchain_confirmed: { branch: "SETTLEMENT", order: 4, kind: "FINANCIAL_SUBMIT" },
  settlement_pi_completed: { branch: "SETTLEMENT", order: 5, kind: "NON_FINANCIAL" },
  settlement_finalized: { branch: "SETTLEMENT", order: 6, kind: "NON_FINANCIAL" },
  refund_eligible: { branch: "REFUND", order: 3, kind: "NON_FINANCIAL" },
  refund_created: { branch: "REFUND", order: 4, kind: "FINANCIAL_CREATE" },
  refund_blockchain_confirmed: { branch: "REFUND", order: 5, kind: "FINANCIAL_SUBMIT" },
  refund_pi_completed: { branch: "REFUND", order: 6, kind: "NON_FINANCIAL" },
  refund_finalized: { branch: "REFUND", order: 7, kind: "NON_FINANCIAL" },
}

export type FinancialRecoveryReconciliationOutcome =
  | "NOT_ATTEMPTED"
  | "FOUND"
  | "CONFIRMED_NONE"
  | "INDETERMINATE"

export type FinancialRecoveryDecisionReason =
  | "INVALID_INPUT"
  | "INDETERMINATE_EVIDENCE"
  | "MULTIPLE_CANDIDATES"
  | "EVIDENCE_CONFLICT"
  | "BRANCH_CONFLICT"
  | "TARGET_ALREADY_REACHED"
  | "EVIDENCE_UNRESOLVED"
  | "RECONCILIATION_REQUIRED"
  | "PREREQUISITES_UNCONFIRMED"
  | "REFERENCE_REQUIRES_RECONCILIATION"
  | "MONEY_MOVED_RESUME_ONLY"
  | "EXISTING_PAYMENT_RESUME_ONLY"
  | "SAFE_CREATE_RETRY"
  | "SAFE_SUBMIT_RETRY"
  | "NON_FINANCIAL_RESUME"
  | "FAIL_CLOSED"

export type FinancialRecoveryDecisionInput = {
  readonly paymentId: string
  readonly currentState: FinancialRecoveryState
  readonly targetState: EvidencedState
  readonly reconciliationOutcome: FinancialRecoveryReconciliationOutcome
  readonly prerequisitesConfirmed: boolean
  readonly targetPaymentIdPresent: boolean
  readonly targetTxidPresent: boolean
  readonly targetMoneyMoved: boolean
  readonly malformed: boolean
  readonly multipleCandidates: boolean
  readonly unknown: EvidenceFactSet
  readonly missing: EvidenceFactSet
  readonly conflicts: EvidenceFactSet
}

export type FinancialRecoveryDecisionResult =
  | {
      readonly decision: "NO_ACTION"
      readonly reason: "TARGET_ALREADY_REACHED"
    }
  | {
      readonly decision: "RESUME_NON_FINANCIAL"
      readonly reason: "MONEY_MOVED_RESUME_ONLY" | "EXISTING_PAYMENT_RESUME_ONLY" | "NON_FINANCIAL_RESUME"
    }
  | {
      readonly decision: "SAFE_FINANCIAL_RETRY"
      readonly reason: "SAFE_CREATE_RETRY" | "SAFE_SUBMIT_RETRY"
    }
  | {
      readonly decision: "RECONCILE_FIRST"
      readonly reason: "EVIDENCE_UNRESOLVED" | "RECONCILIATION_REQUIRED" | "PREREQUISITES_UNCONFIRMED" | "REFERENCE_REQUIRES_RECONCILIATION"
    }
  | {
      readonly decision: "MANUAL_REVIEW"
      readonly reason: "INVALID_INPUT" | "INDETERMINATE_EVIDENCE" | "MULTIPLE_CANDIDATES" | "EVIDENCE_CONFLICT" | "BRANCH_CONFLICT" | "FAIL_CLOSED"
    }
