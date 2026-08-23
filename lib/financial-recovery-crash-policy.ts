import type { FinancialRecoveryCrashEffect, FinancialRecoveryCrashWindow } from "./financial-recovery-crash-window"
import type { EvidencedState } from "./financial-recovery-evidence"
import type {
  FinancialRecoveryDecision,
  FinancialRecoveryReconciliationSource,
} from "./financial-recovery-decision"

export type FinancialRecoveryCrashPolicy = {
  readonly precedingEffect: FinancialRecoveryCrashEffect
  readonly recoveryTargetState: EvidencedState
  readonly onTargetReached: "NO_ACTION"
  readonly onUncertainty: "MANUAL_REVIEW"
  readonly onConflict: "MANUAL_REVIEW"
  readonly evidenceBeforeAction: true
  readonly financialRetryRequiresConfirmedNone: true
} & Readonly<
  | {
      primaryPath: Extract<FinancialRecoveryDecision, "RECONCILE_FIRST">
      reconciliationSource: FinancialRecoveryReconciliationSource
    }
  | {
      primaryPath: Extract<FinancialRecoveryDecision, "RESUME_NON_FINANCIAL">
      reconciliationSource: null
    }
>

export type FinancialRecoveryCrashPolicyMatrix = Readonly<
  Record<FinancialRecoveryCrashWindow, FinancialRecoveryCrashPolicy>
>

export const FINANCIAL_RECOVERY_PRE_REFUND_CRASH_POLICIES = {
  u2a_pi_complete_before_redis_checkpoint: {
    precedingEffect: "PI_STATE_CHANGED",
    recoveryTargetState: "app_funds_confirmed",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "PI_PAYMENT",
  },
  u2a_redis_checkpoint_before_a2u_dispatch: {
    precedingEffect: "LOCAL_ONLY",
    recoveryTargetState: "settlement_created",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "PI_PAYMENT",
  },
  settlement_create_returned_before_id_checkpoint: {
    precedingEffect: "PAYMENT_CREATED",
    recoveryTargetState: "settlement_created",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "PI_PAYMENT",
  },
  settlement_id_checkpoint_before_horizon_submit: {
    precedingEffect: "LOCAL_ONLY",
    recoveryTargetState: "settlement_blockchain_confirmed",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "HORIZON",
  },
  settlement_horizon_confirmed_before_txid_checkpoint: {
    precedingEffect: "MONEY_MOVED",
    recoveryTargetState: "settlement_blockchain_confirmed",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "HORIZON",
  },
  settlement_txid_checkpoint_before_pi_complete: {
    precedingEffect: "LOCAL_ONLY",
    recoveryTargetState: "settlement_pi_completed",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "PI_PAYMENT",
  },
  settlement_pi_complete_before_completion_checkpoint: {
    precedingEffect: "PI_STATE_CHANGED",
    recoveryTargetState: "settlement_pi_completed",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RECONCILE_FIRST",
    reconciliationSource: "PI_PAYMENT",
  },
  settlement_completion_checkpoint_before_accounting: {
    precedingEffect: "LOCAL_ONLY",
    recoveryTargetState: "settlement_finalized",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RESUME_NON_FINANCIAL",
    reconciliationSource: null,
  },
  settlement_accounting_checkpoint_before_db_commit: {
    precedingEffect: "LOCAL_ONLY",
    recoveryTargetState: "settlement_finalized",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RESUME_NON_FINANCIAL",
    reconciliationSource: null,
  },
  settlement_db_commit_before_final_checkpoint: {
    precedingEffect: "DB_COMMITTED",
    recoveryTargetState: "settlement_finalized",
    onTargetReached: "NO_ACTION",
    onUncertainty: "MANUAL_REVIEW",
    onConflict: "MANUAL_REVIEW",
    evidenceBeforeAction: true,
    financialRetryRequiresConfirmedNone: true,
    primaryPath: "RESUME_NON_FINANCIAL",
    reconciliationSource: null,
  },
} as const satisfies Pick<
  FinancialRecoveryCrashPolicyMatrix,
  Extract<FinancialRecoveryCrashWindow, `u2a_${string}` | `settlement_${string}`>
>

export const FINANCIAL_RECOVERY_REFUND_CRASH_POLICIES = {
  refund_eligibility_checkpoint_before_intent_transition: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_created", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_intent_checkpoint_before_submission_attempt: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_created", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_submission_attempt_before_pi_create: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_created", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_pi_create_verified_before_payment_id_checkpoint: { precedingEffect: "PAYMENT_CREATED", recoveryTargetState: "refund_created", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_payment_id_checkpoint_before_horizon_claim: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_blockchain_confirmed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "HORIZON" },
  refund_horizon_claim_before_blockchain_submit: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_blockchain_confirmed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "HORIZON" },
  refund_horizon_confirmed_before_txid_checkpoint: { precedingEffect: "MONEY_MOVED", recoveryTargetState: "refund_blockchain_confirmed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "HORIZON" },
  refund_txid_checkpoint_before_pi_complete: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_pi_completed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_pi_complete_before_payment_projection: { precedingEffect: "PI_STATE_CHANGED", recoveryTargetState: "refund_pi_completed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_payment_projection_before_checkpoint_advance: { precedingEffect: "LOCAL_ONLY", recoveryTargetState: "refund_pi_completed", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RECONCILE_FIRST", reconciliationSource: "PI_PAYMENT" },
  refund_payment_checkpoint_updated_before_accounting_record: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
  refund_accounting_record_before_accounting_checkpoint: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
  refund_accounting_checkpoint_before_audit_checkpoint: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
  refund_audit_checkpoint_before_completion_checkpoint: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
  refund_completion_checkpoint_before_final_projection: { precedingEffect: "DB_COMMITTED", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
  refund_final_projection_before_finality_audit: { precedingEffect: "LOCAL_ONLY", recoveryTargetState: "refund_finalized", onTargetReached: "NO_ACTION", onUncertainty: "MANUAL_REVIEW", onConflict: "MANUAL_REVIEW", evidenceBeforeAction: true, financialRetryRequiresConfirmedNone: true, primaryPath: "RESUME_NON_FINANCIAL", reconciliationSource: null },
} as const satisfies Pick<
  FinancialRecoveryCrashPolicyMatrix,
  Extract<FinancialRecoveryCrashWindow, `refund_${string}`>
>

export const FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX = {
  ...FINANCIAL_RECOVERY_PRE_REFUND_CRASH_POLICIES,
  ...FINANCIAL_RECOVERY_REFUND_CRASH_POLICIES,
} as const satisfies FinancialRecoveryCrashPolicyMatrix
