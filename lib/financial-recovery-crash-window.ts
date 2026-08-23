export type FinancialRecoveryCrashWindow =
  | "u2a_pi_complete_before_redis_checkpoint"
  | "u2a_redis_checkpoint_before_a2u_dispatch"
  | "settlement_create_returned_before_id_checkpoint"
  | "settlement_id_checkpoint_before_horizon_submit"
  | "settlement_horizon_confirmed_before_txid_checkpoint"
  | "settlement_txid_checkpoint_before_pi_complete"
  | "settlement_pi_complete_before_completion_checkpoint"
  | "settlement_completion_checkpoint_before_accounting"
  | "settlement_accounting_checkpoint_before_db_commit"
  | "settlement_db_commit_before_final_checkpoint"

export type FinancialRecoveryCrashEffect =
  | "PI_STATE_CHANGED"
  | "PAYMENT_CREATED"
  | "MONEY_MOVED"
  | "DB_COMMITTED"
  | "LOCAL_ONLY"
