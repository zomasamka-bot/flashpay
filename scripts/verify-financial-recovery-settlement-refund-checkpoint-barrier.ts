import { strict as assert } from "node:assert"
import { evaluateSettlementRefundCheckpointBarrier } from "../lib/financial-recovery-settlement-refund-checkpoint-barrier"

assert.deepEqual(evaluateSettlementRefundCheckpointBarrier("present"), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_EVIDENCE",
})

assert.deepEqual(evaluateSettlementRefundCheckpointBarrier("uncertain"), {
  authorizesFinancialAction: false,
  outcome: "BLOCKED",
  reason: "OPPOSITE_BRANCH_UNCERTAIN",
})

assert.deepEqual(evaluateSettlementRefundCheckpointBarrier("absent"), {
  authorizesFinancialAction: false,
  outcome: "NO_CHECKPOINT_EVIDENCE",
})

const absent = evaluateSettlementRefundCheckpointBarrier("absent")
assert.equal(absent.outcome, "NO_CHECKPOINT_EVIDENCE")
assert.equal(absent.authorizesFinancialAction, false)
assert.notEqual(absent.outcome, "BLOCKED")
assert.notEqual(absent.outcome, "DECISION")
assert.notEqual(absent.authorizesFinancialAction, true)
