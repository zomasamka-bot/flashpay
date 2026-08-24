import { strict as assert } from "node:assert"
import {
  evaluateFinancialRecoveryHorizonProof,
  type HorizonProofInput,
} from "../lib/financial-recovery-horizon-proof"

const expected: HorizonProofInput["expected"] = {
  txid: "tx-1",
  a2uPaymentId: "payment-1",
  fromAddress: "GFROM",
  toAddress: "GTO",
  amount: 2.5,
}

const baseTx: Readonly<Record<string, unknown>> = {
  hash: "tx-1",
  successful: true,
  source_account: "GFROM",
  memo_type: "text",
  memo: "payment-1".substring(0, 28),
  operation_count: 1,
}

const baseOp: Readonly<Record<string, unknown>> = {
  type: "payment",
  transaction_hash: "tx-1",
  transaction_successful: true,
  from: "GFROM",
  to: "GTO",
  asset_type: "native",
  amount: "2.5",
}

function input(transaction: unknown, operations: unknown, expectedValue: HorizonProofInput["expected"] = expected, source: "HORIZON_TX_OPS" | null = "HORIZON_TX_OPS"): HorizonProofInput {
  return { source, transaction, operations, expected: expectedValue }
}

function assertVerified(value: HorizonProofInput): void {
  const result = evaluateFinancialRecoveryHorizonProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "VERIFIED")
  if (result.outcome === "VERIFIED") {
    assert.equal(result.proof, "horizon_tx_exact")
    assert.equal(result.moneyMovementProven, true)
  }
}

function assertRejected(value: HorizonProofInput, reason: "INVALID_INPUT" | "NON_AUTHORITATIVE_SOURCE" | "MALFORMED_OR_MISMATCH"): void {
  const result = evaluateFinancialRecoveryHorizonProof(value)
  assert.equal(result.authorizesFinancialAction, false)
  assert.equal(result.outcome, "INDETERMINATE")
  if (result.outcome === "INDETERMINATE") assert.equal(result.reason, reason)
}

assertVerified(input(baseTx, [baseOp]))
assertRejected(input(baseTx, [baseOp], expected, null), "NON_AUTHORITATIVE_SOURCE")

for (const key of ["txid", "a2uPaymentId", "fromAddress", "toAddress"] as const) {
  assertRejected(input(baseTx, [baseOp], { ...expected, [key]: "" }), "INVALID_INPUT")
}
for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
  assertRejected(input(baseTx, [baseOp], { ...expected, amount }), "INVALID_INPUT")
}

const txMismatches: readonly Readonly<Record<string, unknown>>[] = [
  { hash: "wrong" }, { successful: false }, { source_account: "wrong" },
  { memo_type: "id" }, { memo: "wrong" }, { operation_count: 2 },
]
for (const mismatch of txMismatches) assertRejected(input({ ...baseTx, ...mismatch }, [baseOp]), "MALFORMED_OR_MISMATCH")

for (const operations of [[], [baseOp, baseOp]]) assertRejected(input(baseTx, operations), "MALFORMED_OR_MISMATCH")
assertRejected(input(baseTx, [{ ...baseOp, type: "wrong" }]), "MALFORMED_OR_MISMATCH")
const opWithoutAmount: Readonly<Record<string, unknown>> = {
  type: baseOp.type,
  transaction_hash: baseOp.transaction_hash,
  transaction_successful: baseOp.transaction_successful,
  from: baseOp.from,
  to: baseOp.to,
  asset_type: baseOp.asset_type,
}
assertRejected(input(baseTx, [opWithoutAmount]), "MALFORMED_OR_MISMATCH")
assertRejected(input({ ...baseTx, operation_count: 2 }, [baseOp]), "MALFORMED_OR_MISMATCH")

const opMismatches: readonly Readonly<Record<string, unknown>>[] = [
  { transaction_hash: "wrong" }, { transaction_successful: false }, { from: "wrong" },
  { to: "wrong" }, { asset_type: "credit_alphanum4" }, { amount: "2.4" },
  { amount: "bad" }, { amount: Number.NaN }, { amount: Number.POSITIVE_INFINITY },
]
for (const mismatch of opMismatches) assertRejected(input(baseTx, [{ ...baseOp, ...mismatch }]), "MALFORMED_OR_MISMATCH")

for (const malformed of [null, [], "tx"]) assertRejected(input(malformed, [baseOp]), "MALFORMED_OR_MISMATCH")
for (const operations of [null, {}, [null], ["op"]]) assertRejected(input(baseTx, operations), "MALFORMED_OR_MISMATCH")
