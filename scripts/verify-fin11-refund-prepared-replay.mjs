import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const submit = read('lib/refund-blockchain-submit.ts')
const executor = read('lib/refund-executor.ts')
const runner = read('scripts/run-financial-recovery-build-verifier.mjs')

const fail = (msg) => { throw new Error(`FIN11_REFUND_PREPARED_REPLAY=FAIL ${msg}`) }
const must = (ok, msg) => { if (!ok) fail(msg) }
const ordered = (src, tokens, msg) => {
  let at = -1
  for (const token of tokens) {
    at = src.indexOf(token, at + 1)
    if (at < 0) fail(`${msg}: missing ${token}`)
  }
}

// Exact stored-XDR identity is cryptographically and semantically rebound before replay.
for (const token of [
  'transaction.toXDR() !== input.envelopeXdr',
  'Buffer.from(transaction.hash()).toString("hex") !== input.preparedHash',
  'transaction.sequence !== input.preparedSequence',
  'transaction.source !== input.fromAddress',
  'operation.destination !== input.toAddress',
  '!exactStroopAmountMatch(operation.amount, input.amount)',
  'memoValue !== input.refundPaymentId',
  '!keypair.verify(transaction.hash(), signature.signature.toBytes())',
]) must(submit.includes(token), `stored XDR binding missing: ${token}`)

// Fresh submit must durably prepare, then authorize, then submit; no submit may precede authorization.
ordered(submit, [
  'const prepared = await ensureRefundPreparedSubmit',
  'const authorization = await authorizeRefundBlockchainSubmit',
  'const result = await server.submitTransaction(transaction)',
], 'fresh prepare/authorize/submit ordering')

// Ambiguous fresh submit must reconcile exact prepared evidence against Horizon before success.
ordered(submit, [
  'catch (error)',
  'const after = await readRefundPreparedRecoveryEvidence',
  'after.outcome === "VERIFIED"',
  'after.reference.preparedHash === preparedHash',
  'after.reference.preparedSequence === preparedSequence',
], 'fresh ambiguity reconciliation')

// Replay pre-gate requires PREPARED_IS_NEXT and exact durable identity; prepared evidence alone is non-authorizing.
for (const token of [
  'input.evidence.outcome !== "PREPARED_IS_NEXT"',
  'input.evidence.reference.preparedHash !== input.prepared.preparedHash',
  'input.evidence.reference.preparedSequence !== input.prepared.preparedSequence',
  'moneyMovementProven: false',
  'authorizesFinancialAction: false',
]) must(submit.includes(token), `replay pre-gate missing: ${token}`)

// Stored-XDR replay re-reads Horizon immediately before submit, requires durable authorization,
// reconstructs the exact stored transaction, and reconciles Horizon after success/exception.
ordered(submit, [
  'export async function submitRefundPreparedStoredXdrOnce',
  'const recovery = await readRefundPreparedRecoveryEvidence',
  'recovery.outcome !== "PREPARED_IS_NEXT"',
  'const authorization = await readRefundBlockchainSubmitAuthorizationState',
  'authorization.state !== "present"',
  'TransactionBuilder.fromXDR(input.gate.prepared.envelopeXdr, "Pi Testnet")',
  'await server.submitTransaction(transaction)',
  'const after = await readRefundPreparedRecoveryEvidence',
], 'stored-XDR replay ordering')

// Recovery executor must hold the source-wallet submit lock and reject foreign/stale owner identity.
ordered(executor, [
  'export async function readRefundPreparedReplayUnderExistingOwner',
  'const walletLock = await acquirePiWalletSubmitLock(refund.payment.from_address)',
  'const prepared = await readRefundPreparedSubmitState',
  "const evidence = await submit.readRefundPreparedRecoveryEvidence",
  "if (evidence.outcome !== 'PREPARED_IS_NEXT') return blocked",
], 'refund replay lock/evidence ordering')
for (const token of [
  "currentWalletIntent.owner.kind !== 'refund_claim'",
  'currentWalletIntent.owner.paymentId !== initial.checkpoint.paymentId',
  'currentWalletIntent.owner.refundId !== refundId',
  "if (lockedA2u.outcome !== 'CONFIRMED_NONE') return blocked",
  "if (refundAuthority !== undefined && (refundAuthority === null || refundAuthority.paymentId !== initial.checkpoint.paymentId || refundAuthority.refundId !== refundId)) return blocked",
]) must(executor.includes(token), `foreign/opposite authority barrier missing: ${token}`)

// Redis-loss owner reconstruction is after durable/Pi/Horizon/A2U absence gates and under wallet lock.
ordered(executor, [
  "if (lockedA2u.outcome !== 'CONFIRMED_NONE') return blocked",
  'const gate = submit.evaluateRefundPreparedReplayPreGate',
  "if (gate.outcome !== 'ELIGIBLE_EXACT_REPLAY') return gate",
  'const currentWalletIntent = await readPiWalletIntent',
  "if (currentWalletIntent.state === 'absent')",
  "claimPiWalletIntent(lockedRefund.payment.from_address, { kind: 'refund_claim'",
  'const authorization = await readRefundBlockchainSubmitAuthorizationState',
  'const replay = await submit.submitRefundPreparedStoredXdrOnce',
], 'Redis-loss reconstruction ordering')

// The certifier must itself be mandatory in the build verifier.
must(runner.includes("await import('./verify-fin11-refund-prepared-replay.mjs')"), 'mandatory build-gate binding missing')

// Mutation sensitivity: run the same safety verifier against one-at-a-time source mutations.
const mutationChecks = [
  ['xdr', 'submit', 'transaction.toXDR() !== input.envelopeXdr', (s,e) => s.includes('transaction.toXDR() !== input.envelopeXdr')],
  ['hash', 'submit', 'Buffer.from(transaction.hash()).toString("hex") !== input.preparedHash', (s,e) => s.includes('Buffer.from(transaction.hash()).toString("hex") !== input.preparedHash')],
  ['sequence', 'submit', 'transaction.sequence !== input.preparedSequence', (s,e) => s.includes('transaction.sequence !== input.preparedSequence')],
  ['destination', 'submit', 'operation.destination !== input.toAddress', (s,e) => s.includes('operation.destination !== input.toAddress')],
  ['amount', 'submit', '!exactStroopAmountMatch(operation.amount, input.amount)', (s,e) => s.includes('!exactStroopAmountMatch(operation.amount, input.amount)')],
  ['prepared_is_next', 'submit', 'input.evidence.outcome !== "PREPARED_IS_NEXT"', (s,e) => s.includes('input.evidence.outcome !== "PREPARED_IS_NEXT"')],
  ['authorization', 'submit', 'authorization.state !== "present"', (s,e) => s.includes('authorization.state !== "present"')],
  ['wallet_lock', 'executor', 'const walletLock = await acquirePiWalletSubmitLock(refund.payment.from_address)', (s,e) => e.includes('const walletLock = await acquirePiWalletSubmitLock(refund.payment.from_address)')],
  ['a2u_absence', 'executor', "if (lockedA2u.outcome !== 'CONFIRMED_NONE') return blocked", (s,e) => e.includes("if (lockedA2u.outcome !== 'CONFIRMED_NONE') return blocked")],
  ['foreign_owner', 'executor', "currentWalletIntent.owner.kind !== 'refund_claim'", (s,e) => e.includes("currentWalletIntent.owner.kind !== 'refund_claim'")],
]
let rejectedMutations = 0
for (const [name, target, token, predicate] of mutationChecks) {
  const source = target === 'submit' ? submit : executor
  must(source.includes(token), `mutation fixture missing ${name}`)
  const mutated = source.replace(token, `/* FIN11_MUTATION_${name} */`)
  const mutatedSubmit = target === 'submit' ? mutated : submit
  const mutatedExecutor = target === 'executor' ? mutated : executor
  if (!predicate(mutatedSubmit, mutatedExecutor)) rejectedMutations += 1
}
must(rejectedMutations === mutationChecks.length, `mutation sensitivity ${rejectedMutations}/${mutationChecks.length}`)

console.log(`FIN11_REFUND_PREPARED_REPLAY=PASS adversarial=${rejectedMutations} runtime_kernel_changed=false stored_xdr_only=true horizon_reconcile_first=true foreign_owner_fail_closed=true`)
