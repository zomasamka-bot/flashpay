import { strict as assert } from "node:assert"
import { evaluateFinancialRecoverySettlementRefundOppositeBinding } from "../lib/financial-recovery-settlement-refund-opposite-binding"

assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: null,
}), {
  authorizesFinancialAction: false,
  outcome: "CLEAR",
  oppositePaymentId: "ABSENT",
  oppositeTxid: "ABSENT",
  oppositeMoneyMovement: "ABSENT",
})

assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: null,
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "FOUND",
  refundBlockchainOutcome: null,
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: "VERIFIED_TX",
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" })

assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: null,
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "INDETERMINATE",
  refundBlockchainOutcome: null,
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: "NO_TX",
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "CONFIRMED_NONE",
  refundBlockchainOutcome: "INDETERMINATE",
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" })

assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_UNCERTAIN" },
  refundPiOutcome: "FOUND",
  refundBlockchainOutcome: null,
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" })
assert.deepEqual(evaluateFinancialRecoverySettlementRefundOppositeBinding({
  checkpoint: { authorizesFinancialAction: false, outcome: "NO_CHECKPOINT_EVIDENCE" },
  refundPiOutcome: "INDETERMINATE",
  refundBlockchainOutcome: "VERIFIED_TX",
}), { authorizesFinancialAction: false, outcome: "BLOCKED", reason: "OPPOSITE_BRANCH_EVIDENCE" })
