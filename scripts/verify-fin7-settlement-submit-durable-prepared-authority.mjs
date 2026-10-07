import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const locked = fs.readFileSync(path.join(root, 'lib/a2u-locked-executor.ts'), 'utf8')
const executor = fs.readFileSync(path.join(root, 'lib/a2u-executor.ts'), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(`FIN7_SETTLEMENT_SUBMIT_DURABLE_PREPARED_AUTHORITY=FAIL ${message}`)
}

const redisPrepared = executor.indexOf('ctx.payment = await persistCheckpointMerged(ctx.paymentId, { a2uPreparedEnvelopeXdr: preparedEnvelopeXdr')
const pgPrepared = executor.indexOf('const durablePrepared = await recordSettlementPreparedCheckpoint({', redisPrepared)
assert(redisPrepared >= 0 && pgPrepared > redisPrepared, 'crash window Redis-prepared-before-PostgreSQL-prepared is not source-bound')

const helperStart = locked.indexOf('async function verifySettlementSubmitDurablePreparedAuthority')
const helperEnd = locked.indexOf('\n}\n', helperStart)
assert(helperStart >= 0 && helperEnd > helperStart, 'durable prepared authority helper missing')
const helper = locked.slice(helperStart, helperEnd + 3)
assert(helper.includes('getSettlementCheckpointAuthoritative(paymentId)'), 'helper must read authoritative PostgreSQL settlement checkpoint')
assert(helper.includes('durable.checkpoint.stage !== "prepared"'), 'new financial submit must require durable stage=prepared')
for (const token of [
  'payment.id === d.paymentId',
  'payment.merchantId === d.merchantId',
  'payment.merchantUid === d.merchantUid',
  'payment.customerAmount === d.customerAmount',
  'payment.merchantAmount === d.merchantAmount',
  'payment.a2uPaymentId === d.a2uPaymentId',
  'payment.a2uFromAddress === d.a2uFromAddress',
  'payment.a2uToAddress === d.a2uToAddress',
  'payment.a2uPreparedEnvelopeXdr === d.preparedEnvelopeXdr',
  'payment.a2uPreparedTxHash === d.preparedTxHash',
  'payment.a2uPreparedSequence === d.preparedSequence',
]) assert(helper.includes(token), `exact durable binding missing: ${token}`)

const submitBranch = locked.indexOf('if (params.recoveryOperation === "SETTLEMENT_SUBMIT")')
const durableGuard = locked.indexOf('if (!await verifySettlementSubmitDurablePreparedAuthority(paymentId, latestPayment))', submitBranch)
const walletLock = locked.indexOf('const walletLock = await acquirePiWalletSubmitLock', submitBranch)
const promoteIntent = locked.indexOf('const promoted = await replacePiWalletIntent', submitBranch)
const replay = locked.indexOf('const replay = await executeFinancialRecoverySettlementSubmitReplay', submitBranch)
const horizonSubmit = locked.indexOf('const submitted = await horizon.submitTransaction(transaction)', submitBranch)
assert(submitBranch >= 0 && durableGuard > submitBranch, 'SETTLEMENT_SUBMIT durable guard missing')
assert(durableGuard < walletLock && durableGuard < promoteIntent && durableGuard < replay && durableGuard < horizonSubmit, 'durable guard must precede wallet authority promotion, replay authorization, and Horizon submit')
assert(locked.slice(durableGuard, walletLock).includes('return { ok: false, status: 409'), 'missing fail-closed return when durable authority is absent/conflicting/uncertain')

console.log('FIN7_SETTLEMENT_SUBMIT_DURABLE_PREPARED_AUTHORITY=PASS crash_window=redis_prepared_before_pg_prepared financial_authority=postgres stage=prepared fail_closed=true')
