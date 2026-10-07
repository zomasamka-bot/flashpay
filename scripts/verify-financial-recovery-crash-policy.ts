{
const assert = require("node:assert/strict")
const { FINANCIAL_RECOVERY_CRASH_WINDOWS } = require("../lib/financial-recovery-crash-window")
const { FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX } = require("../lib/financial-recovery-crash-policy")
const expectedWindows = [...FINANCIAL_RECOVERY_CRASH_WINDOWS]
assert.equal(expectedWindows.length, 41, "FIN-7 canonical crash-window count must be 41")
assert.equal(new Set(expectedWindows).size, 41, "FIN-7 canonical crash-window names must be unique")
const actualWindows = Object.keys(FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX).sort()
assert.deepEqual(actualWindows, [...expectedWindows].sort(), "crash-policy matrix must cover exactly the canonical FIN-7 windows")
for (const window of expectedWindows) {
  const policy = FINANCIAL_RECOVERY_CRASH_POLICY_MATRIX[window]
  assert.ok(policy, `${window}: policy must exist`)
  assert.equal(policy.onTargetReached, "NO_ACTION", `${window}: reached target must not repeat action`)
  assert.equal(policy.onUncertainty, "MANUAL_REVIEW", `${window}: uncertainty must fail closed`)
  assert.equal(policy.onConflict, "MANUAL_REVIEW", `${window}: conflict must fail closed`)
  assert.equal(policy.evidenceBeforeAction, true, `${window}: evidence must precede action`)
  assert.ok(policy.retryAuthority === "NEVER" || policy.retryAuthority === "CONFIRMED_NONE", `${window}: retry authority invalid`)
  if (policy.primaryPath === "RECONCILE_FIRST") {
    assert.ok(policy.reconciliationSource === "PI_PAYMENT" || policy.reconciliationSource === "HORIZON", `${window}: reconcile-first requires canonical source`)
  } else {
    assert.ok(policy.primaryPath === "RESUME_NON_FINANCIAL" || policy.primaryPath === "FAIL_CLOSED", `${window}: unknown primary path`)
    assert.equal(policy.reconciliationSource, null, `${window}: non-reconcile path must not invent reconciliation source`)
    assert.equal(policy.retryAuthority, "NEVER", `${window}: non-reconcile path cannot authorize financial retry`)
  }
  if (policy.precedingEffect === "MONEY_MOVED") {
    assert.equal(policy.primaryPath, "RECONCILE_FIRST", `${window}: money-moved window must reconcile first`)
    assert.equal(policy.reconciliationSource, "HORIZON", `${window}: money-moved window must reconcile against Horizon`)
    assert.equal(policy.retryAuthority, "NEVER", `${window}: money-moved window can never retry financial movement`)
  }
  if (window.includes("attempt_claimed")) assert.equal(policy.retryAuthority, "NEVER", `${window}: one-shot attempt claim forbids retry`)
}
console.log(`CRASH_POLICY_CERTIFIER=PASS windows=${actualWindows.length} one_shot_retry=NEVER`)
}
