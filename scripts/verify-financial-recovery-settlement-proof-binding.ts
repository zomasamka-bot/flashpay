import { strict as assert } from "node:assert"
import { bindFinancialRecoverySettlementProof } from "../lib/financial-recovery-settlement-proof-binding"
import type { A2UProofResult } from "../lib/financial-recovery-a2u-proof"
import type { HorizonProofResult } from "../lib/financial-recovery-horizon-proof"

const a2uVerified: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  authorizesFinancialAction: false,
  outcome: "VERIFIED",
  moneyMovementProven: false,
  reference: {
    paymentId: "payment-1",
    merchantUid: "merchant-1",
    a2uPaymentId: "a2u-1",
    txid: "tx-1",
    fromAddress: "app-1",
    toAddress: "user-1",
    amount: 2.5,
  },
}
const horizonVerified: Extract<HorizonProofResult, { outcome: "VERIFIED" }> = {
  authorizesFinancialAction: false,
  outcome: "VERIFIED",
  proof: "horizon_tx_exact",
  moneyMovementProven: true,
  reference: {
    txid: "tx-1",
    a2uPaymentId: "a2u-1",
    fromAddress: "app-1",
    toAddress: "user-1",
    amount: 2.5,
  },
}
const a2uIndeterminate: Extract<A2UProofResult, { outcome: "INDETERMINATE" }> = {
  authorizesFinancialAction: false,
  outcome: "INDETERMINATE",
  reason: "MALFORMED_OR_MISMATCH",
}
const horizonIndeterminate: Extract<HorizonProofResult, { outcome: "INDETERMINATE" }> = {
  authorizesFinancialAction: false,
  outcome: "INDETERMINATE",
  reason: "MALFORMED_OR_MISMATCH",
}

function assertVerified(a2u: A2UProofResult, horizon: HorizonProofResult): void {
  const result = bindFinancialRecoverySettlementProof(a2u, horizon)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "VERIFIED")
  if (result.outcome === "VERIFIED") {
    assert.equal(result.proof, "horizon_tx_exact")
    assert.equal(result.moneyMovementProven, true)
    assert.deepEqual(result.reference, {
      paymentId: "payment-1",
      merchantUid: "merchant-1",
      a2uPaymentId: "a2u-1",
      txid: "tx-1",
      fromAddress: "app-1",
      toAddress: "user-1",
      amount: 2.5,
    })
  }
}

function assertRejected(a2u: A2UProofResult, horizon: HorizonProofResult, reason: Extract<ReturnType<typeof bindFinancialRecoverySettlementProof>, { outcome: "INDETERMINATE" }>["reason"]): void {
  const result = bindFinancialRecoverySettlementProof(a2u, horizon)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "INDETERMINATE")
  if (result.outcome === "INDETERMINATE") assert.equal(result.reason, reason)
}

assertVerified(a2uVerified, horizonVerified)
assertVerified({ ...a2uVerified, reference: { ...a2uVerified.reference, txid: null } }, horizonVerified)
assertRejected(a2uIndeterminate, horizonIndeterminate, "A2U_PROOF_UNVERIFIED")
assertRejected(a2uVerified, horizonIndeterminate, "HORIZON_PROOF_UNVERIFIED")

const mismatchedPaymentId: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  ...a2uVerified,
  reference: { ...a2uVerified.reference, a2uPaymentId: "different" },
}
const mismatchedFromAddress: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  ...a2uVerified,
  reference: { ...a2uVerified.reference, fromAddress: "different" },
}
const mismatchedToAddress: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  ...a2uVerified,
  reference: { ...a2uVerified.reference, toAddress: "different" },
}
const mismatchedAmount: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  ...a2uVerified,
  reference: { ...a2uVerified.reference, amount: 3 },
}
const mismatchedTxid: Extract<A2UProofResult, { outcome: "VERIFIED" }> = {
  ...a2uVerified,
  reference: { ...a2uVerified.reference, txid: "tx-2" },
}
assertRejected(mismatchedPaymentId, horizonVerified, "REFERENCE_MISMATCH")
assertRejected(mismatchedFromAddress, horizonVerified, "REFERENCE_MISMATCH")
assertRejected(mismatchedToAddress, horizonVerified, "REFERENCE_MISMATCH")
assertRejected(mismatchedAmount, horizonVerified, "REFERENCE_MISMATCH")
assertRejected(mismatchedTxid, horizonVerified, "REFERENCE_MISMATCH")
