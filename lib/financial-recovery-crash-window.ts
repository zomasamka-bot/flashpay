export const FINANCIAL_RECOVERY_CRASH_WINDOWS = [
  "u2a_approval_ownership_checkpoint_before_attempt_claim",
  "u2a_approval_attempt_claimed_before_pi_approve",
  "u2a_pi_approved_before_approval_reconciliation",
  "u2a_verified_checkpoint_before_complete_attempt",
  "u2a_complete_attempt_claimed_before_pi_complete",
  "u2a_pi_complete_before_durable_completion_checkpoint",
  "u2a_durable_completion_before_redis_projection",
  "u2a_redis_checkpoint_before_a2u_dispatch",
  "u2a_cancel_attempt_claimed_before_pi_cancel",
  "u2a_pi_cancelled_before_durable_retirement",
  "settlement_create_attempt_claimed_before_pi_create",
  "settlement_create_returned_before_id_checkpoint",
  "settlement_redis_prepared_before_durable_prepared_checkpoint",
  "settlement_durable_prepared_checkpoint_before_horizon_submit",
  "settlement_horizon_confirmed_before_txid_checkpoint",
  "settlement_txid_checkpoint_before_pi_complete",
  "settlement_a2u_complete_attempt_claimed_before_pi_complete",
  "settlement_pi_complete_before_completion_checkpoint",
  "settlement_completion_checkpoint_before_accounting",
  "settlement_accounting_checkpoint_before_db_commit",
  "settlement_db_commit_before_final_checkpoint",
  "refund_eligibility_checkpoint_before_intent_transition",
  "refund_intent_checkpoint_before_submission_attempt",
  "refund_submission_attempt_before_pi_create",
  "refund_create_attempt_claimed_before_pi_create",
  "refund_pi_create_verified_before_payment_id_checkpoint",
  "refund_payment_id_checkpoint_before_horizon_claim",
  "refund_horizon_claim_before_blockchain_submit",
  "refund_horizon_confirmed_before_txid_checkpoint",
  "refund_txid_checkpoint_before_pi_complete",
  "refund_complete_attempt_claimed_before_pi_complete",
  "refund_pi_complete_before_payment_projection",
  "refund_payment_projection_before_checkpoint_advance",
  "refund_payment_checkpoint_updated_before_accounting_record",
  "refund_accounting_record_before_accounting_checkpoint",
  "refund_accounting_checkpoint_before_audit_checkpoint",
  "refund_audit_checkpoint_before_completion_checkpoint",
  "refund_completion_checkpoint_before_final_projection",
  "refund_final_projection_before_finality_audit",
  "dr11_a2u_cancel_attempt_claimed_before_pi_cancel",
  "dr11_a2u_pi_cancelled_before_refund_containment",
] as const

export type FinancialRecoveryCrashWindow = typeof FINANCIAL_RECOVERY_CRASH_WINDOWS[number]

export type FinancialRecoveryCrashEffect =
  | "PI_STATE_CHANGED"
  | "PAYMENT_CREATED"
  | "MONEY_MOVED"
  | "DB_COMMITTED"
  | "LOCAL_ONLY"
