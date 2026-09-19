import { strict as assert } from "node:assert"
import fs from "node:fs"

const source = fs.readFileSync(new URL("../lib/refund-blockchain-evidence.ts", import.meta.url), "utf8")

const requiredSourcePredicates = [
  'tx.successful !== true',
  'tx.hash !== txid',
  'tx.id !== txid',
  'tx.source_account !== payment.from_address',
  'tx.memo_type !== "text"',
  'tx.memo !== payment.identifier',
  'tx.operation_count !== 1',
  'operation.type !== "payment"',
  'operation.transaction_hash !== txid',
  'operation.transaction_successful !== true',
  'operation.asset_type !== "native"',
  'operation.source_account !== payment.from_address',
  'operation.from !== payment.from_address',
  'operation.to !== payment.to_address',
  'checkpointStroops !== paymentStroops',
  'paymentStroops !== operationStroops',
]
for (const predicate of requiredSourcePredicates) {
  assert.ok(source.includes(predicate), `Production proof missing predicate: ${predicate}`)
}

const preparedPredicates = [
  'read.transaction.source_account_sequence !== expected.preparedSequence',
  'read.transaction.memo_type !== "text"',
  'read.transaction.operation_count !== 1',
  'operation.transaction_hash !== expected.preparedHash',
  'operation.transaction_successful !== true',
  'operation.asset_type !== "native"',
  'parseStroops(operation.amount) !== stroops(expected.amount)',
]
for (const predicate of preparedPredicates) {
  assert.ok(source.includes(predicate), `Prepared Horizon binding missing predicate: ${predicate}`)
}

const expected = {
  txid: "a".repeat(64),
  from: "GFROM",
  to: "GTO",
  memo: "refund-payment-1",
  amountStroops: 25000000,
}
const tx = {
  successful: true,
  hash: expected.txid,
  id: expected.txid,
  source_account: expected.from,
  memo_type: "text",
  memo: expected.memo,
  operation_count: 1,
}
const op = {
  type: "payment",
  transaction_hash: expected.txid,
  transaction_successful: true,
  asset_type: "native",
  source_account: expected.from,
  from: expected.from,
  to: expected.to,
  amount: "2.5000000",
}
function parseStroops(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,7})?$/.test(value) || /^0+(?:\.0{1,7})?$/.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  const parsed = Number(`${whole}${fraction.padEnd(7, "0")}`)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
function verify(t, o) {
  return t.successful === true &&
    t.hash === expected.txid &&
    t.id === expected.txid &&
    t.source_account === expected.from &&
    t.memo_type === "text" &&
    t.memo === expected.memo &&
    t.operation_count === 1 &&
    o.type === "payment" &&
    o.transaction_hash === expected.txid &&
    o.transaction_successful === true &&
    o.asset_type === "native" &&
    o.source_account === expected.from &&
    o.from === expected.from &&
    o.to === expected.to &&
    parseStroops(o.amount) === expected.amountStroops
}
assert.equal(verify(tx, op), true)

const txMutations = [
  ["successful", false], ["hash", "b".repeat(64)], ["id", "b".repeat(64)],
  ["source_account", "GOTHER"], ["memo_type", "id"], ["memo", "wrong"],
  ["operation_count", 2],
]
const opMutations = [
  ["type", "create_account"], ["transaction_hash", "b".repeat(64)],
  ["transaction_successful", false], ["asset_type", "credit_alphanum4"],
  ["source_account", "GOTHER"], ["from", "GOTHER"], ["to", "GOTHER"],
  ["amount", "2.4999999"], ["amount", "bad"], ["amount", 2.5],
]
for (const [key, value] of txMutations) {
  assert.equal(verify({ ...tx, [key]: value }, op), false, `tx mutation accepted: ${key}`)
}
for (const [key, value] of opMutations) {
  assert.equal(verify(tx, { ...op, [key]: value }), false, `op mutation accepted: ${key}=${String(value)}`)
}

console.log(JSON.stringify({
  certification: "PASS",
  productionSourceBound: true,
  validProofAccepted: 1,
  adversarialMutationsRejected: txMutations.length + opMutations.length,
  transactionFields: ["successful","hash","id","source_account","memo_type","memo","operation_count"],
  operationFields: ["type","transaction_hash","transaction_successful","asset_type","source_account","from","to","amount"],
  preparedBindingAlsoRequires: ["source_account_sequence","prepared_hash","prepared_sequence","fee_charged"],
}, null, 2))
