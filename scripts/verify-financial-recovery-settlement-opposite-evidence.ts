import { strict as assert } from "node:assert"
import { deriveSettlementOppositeEvidence } from "../lib/financial-recovery-settlement-opposite-evidence"

assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "FOUND", refundBlockchainOutcome: null }),
  { oppositePaymentId: "PRESENT", oppositeTxid: "UNKNOWN", oppositeMoneyMovement: "UNKNOWN" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "CONFIRMED_NONE", refundBlockchainOutcome: null }),
  { oppositePaymentId: "ABSENT", oppositeTxid: "UNKNOWN", oppositeMoneyMovement: "UNKNOWN" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "INDETERMINATE", refundBlockchainOutcome: null }),
  { oppositePaymentId: "UNKNOWN", oppositeTxid: "UNKNOWN", oppositeMoneyMovement: "UNKNOWN" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "CONFIRMED_NONE", refundBlockchainOutcome: "VERIFIED_TX" }),
  { oppositePaymentId: "ABSENT", oppositeTxid: "PRESENT", oppositeMoneyMovement: "PRESENT" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "CONFIRMED_NONE", refundBlockchainOutcome: "NO_TX" }),
  { oppositePaymentId: "ABSENT", oppositeTxid: "UNKNOWN", oppositeMoneyMovement: "UNKNOWN" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "CONFIRMED_NONE", refundBlockchainOutcome: "INDETERMINATE" }),
  { oppositePaymentId: "ABSENT", oppositeTxid: "UNKNOWN", oppositeMoneyMovement: "UNKNOWN" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "FOUND", refundBlockchainOutcome: "VERIFIED_TX" }),
  { oppositePaymentId: "PRESENT", oppositeTxid: "PRESENT", oppositeMoneyMovement: "PRESENT" },
)
assert.deepEqual(
  deriveSettlementOppositeEvidence({ refundPiOutcome: "INDETERMINATE", refundBlockchainOutcome: "VERIFIED_TX" }),
  { oppositePaymentId: "UNKNOWN", oppositeTxid: "PRESENT", oppositeMoneyMovement: "PRESENT" },
)
