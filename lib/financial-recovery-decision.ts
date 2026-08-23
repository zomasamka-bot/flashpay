import type { FinancialRecoveryState } from "./financial-recovery-state"
import type { EvidenceFact, EvidencedState } from "./financial-recovery-evidence"

export type FinancialRecoveryDecision =
  | "NO_ACTION"
  | "RESUME_NON_FINANCIAL"
  | "SAFE_FINANCIAL_RETRY"
  | "RECONCILE_FIRST"
  | "MANUAL_REVIEW"

export type EvidenceFactSet = readonly EvidenceFact[]
export type FinancialRecoveryMoneyMovementProof = Extract<EvidenceFact, "horizon_tx_exact" | "refund_horizon_tx_exact">

export type FinancialRecoveryBranch = "COMMON" | "SETTLEMENT" | "REFUND"
export type FinancialRecoveryTargetKind = "NON_FINANCIAL" | "FINANCIAL_CREATE" | "FINANCIAL_SUBMIT"
export type FinancialRecoveryOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type FinancialRecoveryReconciliationSource = "PI_PAYMENT" | "HORIZON" | "PERSISTENCE" | "COMPOSITE"

export type FinancialRecoveryTargetRule = {
  readonly branch: FinancialRecoveryBranch
  readonly order: FinancialRecoveryOrder
  readonly kind: FinancialRecoveryTargetKind
  readonly reconciliationSource: FinancialRecoveryReconciliationSource
}

export const FINANCIAL_RECOVERY_TARGET_RULES: Readonly<Record<EvidencedState, FinancialRecoveryTargetRule>> = {
  u2a_verified: { branch: "COMMON", order: 1, kind: "NON_FINANCIAL", reconciliationSource: "PI_PAYMENT" },
  app_funds_confirmed: { branch: "COMMON", order: 2, kind: "NON_FINANCIAL", reconciliationSource: "PI_PAYMENT" },
  settlement_created: { branch: "SETTLEMENT", order: 3, kind: "FINANCIAL_CREATE", reconciliationSource: "PI_PAYMENT" },
  settlement_blockchain_confirmed: { branch: "SETTLEMENT", order: 4, kind: "FINANCIAL_SUBMIT", reconciliationSource: "HORIZON" },
  settlement_pi_completed: { branch: "SETTLEMENT", order: 5, kind: "NON_FINANCIAL", reconciliationSource: "PI_PAYMENT" },
  settlement_finalized: { branch: "SETTLEMENT", order: 6, kind: "NON_FINANCIAL", reconciliationSource: "PERSISTENCE" },
  refund_eligible: { branch: "REFUND", order: 3, kind: "NON_FINANCIAL", reconciliationSource: "COMPOSITE" },
  refund_created: { branch: "REFUND", order: 4, kind: "FINANCIAL_CREATE", reconciliationSource: "PI_PAYMENT" },
  refund_blockchain_confirmed: { branch: "REFUND", order: 5, kind: "FINANCIAL_SUBMIT", reconciliationSource: "HORIZON" },
  refund_pi_completed: { branch: "REFUND", order: 6, kind: "NON_FINANCIAL", reconciliationSource: "PI_PAYMENT" },
  refund_finalized: { branch: "REFUND", order: 7, kind: "NON_FINANCIAL", reconciliationSource: "COMPOSITE" },
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
  readonly reconciliationSource: FinancialRecoveryReconciliationSource | null
  readonly prerequisitesConfirmed: boolean
  readonly targetPaymentIdPresent: boolean
  readonly targetTxidPresent: boolean
  readonly targetMoneyMovementProof: FinancialRecoveryMoneyMovementProof | null
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

export function decideFinancialRecovery(input: FinancialRecoveryDecisionInput): FinancialRecoveryDecisionResult {
  const invalid = (reason: "INVALID_INPUT" | "INDETERMINATE_EVIDENCE" | "MULTIPLE_CANDIDATES" | "EVIDENCE_CONFLICT" | "BRANCH_CONFLICT" | "FAIL_CLOSED"): FinancialRecoveryDecisionResult => ({
    decision: "MANUAL_REVIEW",
    reason,
  })

  if (!input.paymentId.trim() || input.malformed) return invalid("INVALID_INPUT")
  if (input.currentState === "indeterminate" || input.reconciliationOutcome === "INDETERMINATE") return invalid("INDETERMINATE_EVIDENCE")
  if (input.multipleCandidates) return invalid("MULTIPLE_CANDIDATES")
  if (input.conflicts.length > 0) return invalid("EVIDENCE_CONFLICT")

  const targetRule = FINANCIAL_RECOVERY_TARGET_RULES[input.targetState]
  if (input.reconciliationOutcome === "NOT_ATTEMPTED" && input.reconciliationSource !== null) return invalid("EVIDENCE_CONFLICT")
  if ((input.reconciliationOutcome === "FOUND" || input.reconciliationOutcome === "CONFIRMED_NONE") && input.reconciliationSource !== targetRule.reconciliationSource) return invalid("EVIDENCE_CONFLICT")
  const expectedMoneyMovementProof: FinancialRecoveryMoneyMovementProof | null =
    targetRule.branch === "SETTLEMENT" ? "horizon_tx_exact" : targetRule.branch === "REFUND" ? "refund_horizon_tx_exact" : null
  if (input.targetMoneyMovementProof !== null && input.targetMoneyMovementProof !== expectedMoneyMovementProof) return invalid("EVIDENCE_CONFLICT")
  const targetMoneyMoved = input.targetMoneyMovementProof !== null
  if (input.reconciliationOutcome === "CONFIRMED_NONE" && (input.targetTxidPresent || targetMoneyMoved || (targetRule.kind === "FINANCIAL_CREATE" && input.targetPaymentIdPresent))) {
    return invalid("EVIDENCE_CONFLICT")
  }
  const currentRule = input.currentState === "u2a_unverified"
    ? undefined
    : FINANCIAL_RECOVERY_TARGET_RULES[input.currentState]

  if (currentRule && currentRule.branch !== "COMMON" && targetRule.branch !== "COMMON" && currentRule.branch !== targetRule.branch) {
    return invalid("BRANCH_CONFLICT")
  }
  if (input.unknown.length > 0) return { decision: "RECONCILE_FIRST", reason: "EVIDENCE_UNRESOLVED" }
  if (!input.prerequisitesConfirmed) return { decision: "RECONCILE_FIRST", reason: "PREREQUISITES_UNCONFIRMED" }
  if (currentRule && currentRule.order >= targetRule.order && (currentRule.branch === targetRule.branch || targetRule.branch === "COMMON")) {
    return { decision: "NO_ACTION", reason: "TARGET_ALREADY_REACHED" }
  }
  if (targetMoneyMoved) return { decision: "RESUME_NON_FINANCIAL", reason: "MONEY_MOVED_RESUME_ONLY" }
  if (input.targetTxidPresent) return { decision: "RECONCILE_FIRST", reason: "REFERENCE_REQUIRES_RECONCILIATION" }
  if (input.reconciliationOutcome === "NOT_ATTEMPTED") return { decision: "RECONCILE_FIRST", reason: "RECONCILIATION_REQUIRED" }
  if (targetRule.kind === "FINANCIAL_CREATE" && input.reconciliationOutcome === "FOUND" && input.targetPaymentIdPresent) {
    return { decision: "RESUME_NON_FINANCIAL", reason: "EXISTING_PAYMENT_RESUME_ONLY" }
  }
  if (targetRule.kind === "FINANCIAL_SUBMIT" && input.reconciliationOutcome === "FOUND") {
    return { decision: "RECONCILE_FIRST", reason: "REFERENCE_REQUIRES_RECONCILIATION" }
  }
  if (
    targetRule.kind === "FINANCIAL_CREATE" &&
    input.reconciliationOutcome === "CONFIRMED_NONE" &&
    input.targetPaymentIdPresent === false &&
    input.targetTxidPresent === false &&
    targetMoneyMoved === false
  ) {
    return { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_CREATE_RETRY" }
  }
  if (
    targetRule.kind === "FINANCIAL_SUBMIT" &&
    input.reconciliationOutcome === "CONFIRMED_NONE" &&
    input.targetPaymentIdPresent &&
    input.targetTxidPresent === false &&
    targetMoneyMoved === false
  ) {
    return { decision: "SAFE_FINANCIAL_RETRY", reason: "SAFE_SUBMIT_RETRY" }
  }
  if (targetRule.kind === "NON_FINANCIAL") return { decision: "RESUME_NON_FINANCIAL", reason: "NON_FINANCIAL_RESUME" }
  return invalid("FAIL_CLOSED")
}
