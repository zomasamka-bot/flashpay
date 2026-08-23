import type { FinancialRecoveryCrashEffect, FinancialRecoveryCrashWindow } from "./financial-recovery-crash-window"
import type { EvidencedState } from "./financial-recovery-evidence"
import type {
  FinancialRecoveryDecision,
  FinancialRecoveryReconciliationSource,
} from "./financial-recovery-decision"

export type FinancialRecoveryCrashPolicy = {
  readonly effect: FinancialRecoveryCrashEffect
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
