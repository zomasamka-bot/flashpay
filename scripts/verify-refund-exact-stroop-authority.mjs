import { strict as assert } from "node:assert"
import fs from "node:fs"
import {
  exactPositiveStroopsToStellarAmount,
  exactStroopAmountMatch,
  numberToExactPositiveStroops,
  stellarAmountToExactPositiveStroops,
} from "../lib/financial-amount-stroops.ts"

const submit = fs.readFileSync(new URL("../lib/refund-blockchain-submit.ts", import.meta.url), "utf8")
const evidence = fs.readFileSync(new URL("../lib/refund-blockchain-evidence.ts", import.meta.url), "utf8")

assert.ok(submit.includes('exactStroopAmountMatch(operation.amount, input.amount)'))
assert.ok(!submit.includes('operation.amount !== input.amount.toFixed(7)'))
assert.ok(submit.includes('numberToExactPositiveStroops(input.payment.amount)'))
assert.ok(submit.includes('exactPositiveStroopsToStellarAmount(refundAmountStroops)'))
assert.ok(submit.includes('amount: refundStellarAmount'))
assert.ok(!submit.includes('amount: input.payment.amount.toFixed(7)'))
assert.ok(evidence.includes('numberToExactPositiveStroops(expected.amount) === null'))
assert.ok(evidence.includes('!exactStroopAmountMatch(operation.amount, expected.amount)'))
assert.ok(evidence.includes('stellarAmountToExactPositiveStroops(operation.amount)'))
assert.ok(!evidence.includes('function stroops('))
assert.ok(!evidence.includes('function parseStroops('))

const exact = [
  [0.1, 1_000_000, "0.1000000"],
  [0.0000001, 1, "0.0000001"],
  [1, 10_000_000, "1.0000000"],
  [123.456789, 1_234_567_890, "123.4567890"],
]
for (const [pi, stroops, stellar] of exact) {
  assert.equal(numberToExactPositiveStroops(pi), stroops)
  assert.equal(exactPositiveStroopsToStellarAmount(stroops), stellar)
  assert.equal(stellarAmountToExactPositiveStroops(stellar), stroops)
  assert.equal(exactStroopAmountMatch(stellar, pi), true)
}

for (const value of [0, -0.1, Number.NaN, Infinity, -Infinity, 0.12345678]) {
  assert.equal(numberToExactPositiveStroops(value), null, `unsafe Pi amount accepted: ${String(value)}`)
}
for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
  assert.equal(exactPositiveStroopsToStellarAmount(value), null, `unsafe stroop amount formatted: ${String(value)}`)
}

assert.equal(exactStroopAmountMatch("0.1000001", 0.1), false)
assert.equal(exactStroopAmountMatch("0.0999999", 0.1), false)
assert.equal(exactStroopAmountMatch("0.0000002", 0.0000001), false)
assert.equal(exactStroopAmountMatch("0.0000000", 0.0000001), false)
assert.equal(exactStroopAmountMatch("0.10000000", 0.1), false)
assert.equal(exactStroopAmountMatch("1e-1", 0.1), false)

console.log(JSON.stringify({
  certification: "PASS",
  gate: "REFUND-EXACT-STROOP-AUTHORITY",
  exactCases: exact.length,
  oneStroopMutationsBlocked: true,
  zeroNegativeNonFiniteBlocked: true,
  moreThan7DecimalsBlocked: true,
  buildAuthority: "canonical_stroops",
  preparedXdrAuthority: "canonical_stroops",
  horizonEvidenceAuthority: "canonical_stroops",
  financialMovementExecuted: false,
}, null, 2))
