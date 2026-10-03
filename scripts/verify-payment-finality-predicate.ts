{
const assert = require("node:assert").strict
const { isPaymentFinal } = require("../lib/payment-status.ts")

const tx = "a".repeat(64)
const canonical = {
  id: "payment-finality-proof",
  merchantId: "merchant-proof",
  merchantUid: "merchant-uid-proof",
  amount: 2.5,
  customerAmount: 2.5,
  merchantAmount: 2.5,
  horizonFeeCharged: 0.00001,
  appCommission: 0,
  appNetImpact: -0.00001,
  note: "finality proof",
  status: "settled_to_merchant",
  createdAt: "2026-10-03T00:00:00.000Z",
  settledAt: "2026-10-03T00:00:10.000Z",
  piPaymentId: "pi-payment-proof",
  u2aTxid: tx,
  a2uPaymentId: "a2u-payment-proof",
  a2uTxid: tx,
  requiresDbReconciliation: false,
  horizonSuccessFlag: true,
  horizonSuccessAt: "2026-10-03T00:00:05.000Z",
  piCompletionPending: false,
  piCompleted: true,
  dbRecorded: true,
}

assert.equal(isPaymentFinal(canonical), true, "canonical final payment must be final")

const adversarial = [
  { ...canonical, status: "settlement_pending" },
  { ...canonical, piCompleted: false },
  { ...canonical, dbRecorded: false },
  { ...canonical, requiresDbReconciliation: true },
  { ...canonical, horizonSuccessFlag: false },
  { ...canonical, piCompletionPending: true },
  { ...canonical, merchantId: "" },
  { ...canonical, merchantUid: "" },
  { ...canonical, piPaymentId: "" },
  { ...canonical, a2uPaymentId: "" },
  { ...canonical, u2aTxid: "bad" },
  { ...canonical, a2uTxid: "bad" },
  { ...canonical, amount: 2.4 },
  { ...canonical, customerAmount: 2.4 },
  { ...canonical, merchantAmount: 2.4 },
  { ...canonical, horizonFeeCharged: -0.00001, appNetImpact: 0.00001 },
  { ...canonical, appCommission: 0.1 },
  { ...canonical, appNetImpact: 0 },
  { ...canonical, horizonSuccessAt: "invalid" },
  { ...canonical, settledAt: "invalid" },
  { ...canonical, horizonSuccessAt: "2026-10-03T00:00:11.000Z" },
]

for (const payment of adversarial) assert.equal(isPaymentFinal(payment), false)
console.log(`PAYMENT_FINALITY_PREDICATE_CERTIFIER=PASS adversarial=${adversarial.length}`)
}
