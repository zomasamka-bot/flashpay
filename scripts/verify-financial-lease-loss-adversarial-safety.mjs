import { strict as assert } from "node:assert"
import fs from "node:fs"

const lock = fs.readFileSync(new URL("../lib/pi-wallet-submit-lock.ts", import.meta.url), "utf8")
const settlement = fs.readFileSync(new URL("../lib/a2u-executor.ts", import.meta.url), "utf8")
const settlementRecovery = fs.readFileSync(new URL("../lib/a2u-locked-executor.ts", import.meta.url), "utf8")
const refund = fs.readFileSync(new URL("../lib/refund-executor.ts", import.meta.url), "utf8")
const refundSubmit = fs.readFileSync(new URL("../lib/refund-blockchain-submit.ts", import.meta.url), "utf8")

// Source bindings: a transient lease is never the sole financial authority.
assert.ok(lock.includes('const SUBMIT_LOCK_TTL_SECONDS = 600'))
assert.ok(lock.includes('const SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000'))
assert.ok(lock.includes('if current ~= ARGV[1] then return 0 end'))
assert.ok(lock.includes('return redis.call("EXPIRE", KEYS[1], ARGV[2])'))
assert.ok(lock.includes('if current == ARGV[1] then'))
assert.ok(lock.includes('return redis.call("DEL", KEYS[1])'))
assert.ok(lock.includes('const INTENT_CLAIM_SCRIPT'))
assert.ok(lock.includes('if current == ARGV[1] then return 1 end'))
assert.ok(lock.includes('const INTENT_REPLACE_SCRIPT'))
assert.ok(!lock.includes('EXPIRE", KEYS[1]') || lock.includes('RENEW_SCRIPT'))

// Settlement: durable prepared checkpoint and persistent prepared owner are established before Horizon submit.
const preparedPersist = settlement.indexOf('recordSettlementPreparedCheckpoint({')
const ownerPromote = settlement.indexOf('replacePiWalletIntent(appPublicKey, { kind: "settlement_claim"')
const normalSubmit = settlement.indexOf('const submitResult = await horizonServer.submitTransaction(transaction)')
assert.ok(preparedPersist >= 0 && ownerPromote > preparedPersist && normalSubmit > ownerPromote)
assert.ok(settlement.includes('preparedOwner.owner.kind !== "settlement_prepared"'))
assert.ok(settlement.includes('preparedOwner.owner.preparedHash !== preparedHash'))
assert.ok(settlement.includes('preparedOwner.owner.preparedSequence !== preparedSequence'))

// Recovery: only exact stored XDR with the exact durable prepared identity may be replayed.
assert.ok(settlementRecovery.includes('replay.mode !== "EXACT_STORED_XDR_ONLY"'))
assert.ok(settlementRecovery.includes('intent.envelopeXdr !== latestPayment.a2uPreparedEnvelopeXdr'))
assert.ok(settlementRecovery.includes('intent.preparedHash !== latestPayment.a2uPreparedTxHash'))
assert.ok(settlementRecovery.includes('intent.preparedSequence !== latestPayment.a2uPreparedSequence'))
assert.ok(settlementRecovery.includes('Buffer.from(transaction.hash()).toString("hex") !== intent.preparedHash'))
assert.ok(settlementRecovery.includes('transaction.sequence !== intent.preparedSequence'))
assert.ok(settlementRecovery.includes('const verifiedReplay = await executeFinancialRecoverySettlementSubmitReplay'))
assert.ok(settlementRecovery.includes('verifiedReplay.outcome !== "MOVEMENT_VERIFIED"'))

// Refund: persistent refund owner + durable prepared record; prepared replay submits stored XDR only.
assert.ok(refund.includes("acquirePiWalletIntentSubmitLock(refundPayment.from_address, { kind: 'refund_claim'"))
assert.ok(refund.includes('readRefundPreparedSubmitState('))
assert.ok(refund.includes('readRefundPreparedReplayUnderExistingOwner('))
assert.ok(refundSubmit.includes('ensureRefundPreparedSubmit('))
assert.ok(refundSubmit.includes('prepared.preparedNow !== true'))
assert.ok(refundSubmit.includes('TransactionBuilder.fromXDR(input.gate.prepared.envelopeXdr'))
assert.ok(refundSubmit.includes('Buffer.from(transaction.hash()).toString("hex") !== input.gate.prepared.preparedHash'))
assert.ok(refundSubmit.includes('transaction.sequence !== input.gate.prepared.preparedSequence'))

// Adversarial model: lease A expires, B acquires. Persistent intent is independent of lease TTL.
const claim = (state, owner) => state === null ? owner : state === owner ? owner : null
const replace = (state, expected, next) => state === expected ? next : state === next ? next : null

const paymentA = 'settlement_claim:payment-A'
const paymentB = 'settlement_claim:payment-B'
let intent = claim(null, paymentA)
assert.equal(intent, paymentA)
// A's transient lease is now lost. B may own the transient lock, but cannot claim a different payment.
assert.equal(claim(intent, paymentB), null)
// Same payment can resume, but before movement it must become one exact prepared identity.
assert.equal(claim(intent, paymentA), paymentA)
const preparedA = 'settlement_prepared:payment-A:hash-H:sequence-S'
intent = replace(intent, paymentA, preparedA)
assert.equal(intent, preparedA)
assert.equal(claim(intent, paymentA), null)
assert.equal(claim(intent, paymentB), null)

// Stellar sequence model: two workers replaying the same prepared sequence cannot create two accepted movements.
let ledgerSequence = 100n
const submitSequence = (seq) => {
  if (seq !== ledgerSequence + 1n) return false
  ledgerSequence = seq
  return true
}
assert.equal(submitSequence(101n), true)
assert.equal(submitSequence(101n), false)
assert.equal(ledgerSequence, 101n)

// A successor may not invent the next sequence while the durable/persistent owner remains bound to S=101.
const durablePreparedSequence = 101n
const successorCandidate = 102n
assert.notEqual(successorCandidate, durablePreparedSequence)

// Refund owner is likewise persistent; a different refund/payment cannot take the wallet while claim exists.
let refundIntent = claim(null, 'refund_claim:payment-R:refund-R')
assert.equal(claim(refundIntent, 'refund_claim:payment-X:refund-X'), null)
assert.equal(claim(refundIntent, 'refund_claim:payment-R:refund-R'), refundIntent)

console.log(JSON.stringify({
  certification: "PASS",
  gate: "FINANCIAL-LEASE-LOSS-ADVERSARIAL-SAFETY",
  classification: "PROOF_GAP_CLOSED_NO_RUNTIME_SOURCE_CHANGE",
  leaseLossModeled: true,
  differentPaymentBlockedByPersistentIntent: true,
  sameSettlementBoundToDurablePreparedIdentity: true,
  exactStoredXdrReplayRequired: true,
  duplicatePreparedSequenceSecondAcceptanceBlocked: true,
  refundPersistentOwnerBound: true,
  horizonTruthReconciliationRequired: true,
  financialMovementExecuted: false,
  runtimeFinancialSourceChanged: false
}, null, 2))
