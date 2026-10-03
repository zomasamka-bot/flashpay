const assert = require("node:assert").strict
const { evaluateSettlementRefundCheckpointBarrier } = require("../lib/financial-recovery-settlement-refund-checkpoint-barrier.ts")

const present = evaluateSettlementRefundCheckpointBarrier("present")
assert.deepEqual(present, {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_EVIDENCE",
})

const uncertain = evaluateSettlementRefundCheckpointBarrier("uncertain")
assert.deepEqual(uncertain, {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})

const absent = evaluateSettlementRefundCheckpointBarrier("absent")
assert.deepEqual(absent, {
  authorizesFinancialAction: false,
  outcome: "NO_CHECKPOINT_EVIDENCE",
})

assert.equal(absent.outcome, "NO_CHECKPOINT_EVIDENCE")
assert.equal(absent.authorizesFinancialAction, false)
assert.notEqual(absent.outcome, "BLOCKED")
assert.notEqual(absent.outcome, "DECISION")
assert.notEqual(absent.authorizesFinancialAction, true)

console.log("REFUND_COMPLETION_BARRIER_CERTIFIER=PASS")
