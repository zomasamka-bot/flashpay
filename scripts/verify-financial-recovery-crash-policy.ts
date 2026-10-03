{
const assert = require("node:assert/strict")
const {
  FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX,
} = require("../lib/financial-recovery-crash-policy")

const expectedWindows = [
  "u2a_pi_complete_before_redis_checkpoint",
  "u2a_redis_checkpoint_before_a2u_dispatch",
  "settlement_create_returned_before_id_checkpoint",
  "settlement_id_checkpoint_before_horizon_submit",
  "settlement_horizon_confirmed_before_txid_checkpoint",
  "settlement_txid_checkpoint_before_pi_complete",
  "settlement_pi_complete_before_completion_checkpoint",
  "settlement_completion_checkpoint_before_accounting",
  "settlement_accounting_checkpoint_before_db_commit",
  "settlement_db_commit_before_final_checkpoint",
  "refund_eligibility_checkpoint_before_intent_transition",
  "refund_intent_checkpoint_before_submission_attempt",
  "refund_submission_attempt_before_pi_create",
  "refund_pi_create_verified_before_payment_id_checkpoint",
  "refund_payment_id_checkpoint_before_horizon_claim",
  "refund_horizon_claim_before_blockchain_submit",
  "refund_horizon_confirmed_before_txid_checkpoint",
  "refund_txid_checkpoint_before_pi_complete",
  "refund_pi_complete_before_payment_projection",
  "refund_payment_projection_before_checkpoint_advance",
  "refund_payment_checkpoint_updated_before_accounting_record",
  "refund_accounting_record_before_accounting_checkpoint",
  "refund_accounting_checkpoint_before_audit_checkpoint",
  "refund_audit_checkpoint_before_completion_checkpoint",
  "refund_completion_checkpoint_before_final_projection",
  "refund_final_projection_before_finality_audit",
]

const actualWindows = Object.keys(FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX).sort()
assert.deepEqual(actualWindows, [...expectedWindows].sort(), "crash-policy matrix must cover exactly the canonical 26 windows")

for (const window of expectedWindows) {
  const policy = FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX[window]
  assert.ok(policy, `${window}: policy must exist`)
  assert.equal(policy.onTargetReached, "NO_ACTION", `${window}: reached target must not repeat action`)
  assert.equal(policy.onUncertainty, "MANUAL_REVIEW", `${window}: uncertainty must fail closed`)
  assert.equal(policy.onConflict, "MANUAL_REVIEW", `${window}: conflict must fail closed`)
  assert.equal(policy.evidenceBeforeAction, true, `${window}: evidence must precede action`)
  assert.equal(policy.financialRetryRequiresConfirmedNone, true, `${window}: financial retry requires CONFIRMED_NONE`)

  if (policy.primaryPath === "RECONCILE_FIRST") {
    assert.ok(policy.reconciliationSource === "PI_PAYMENT" || policy.reconciliationSource === "HORIZON", `${window}: reconcile-first requires a canonical source`)
  } else {
    assert.equal(policy.primaryPath, "RESUME_NON_FINANCIAL", `${window}: unknown primary path`)
    assert.equal(policy.reconciliationSource, null, `${window}: non-financial resume must not invent reconciliation source`)
  }

  if (policy.precedingEffect === "MONEY_MOVED") {
    assert.equal(policy.primaryPath, "RECONCILE_FIRST", `${window}: money-moved window must reconcile first`)
    assert.equal(policy.reconciliationSource, "HORIZON", `${window}: money-moved window must reconcile against Horizon`)
  }
}

console.log(`CRASH_POLICY_CERTIFIER=PASS windows=${actualWindows.length}`)
}
