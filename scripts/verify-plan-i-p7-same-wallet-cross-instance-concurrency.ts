import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const need = (ok: unknown, message: string): void => { if (!ok) throw new Error(message) }
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8")

const lock = read("lib/pi-wallet-submit-lock.ts")
const a2u = read("lib/a2u-executor.ts")
const locked = read("lib/a2u-locked-executor.ts")
const refund = read("lib/refund-executor.ts")
const refundSubmit = read("lib/refund-blockchain-submit.ts")

need(lock.includes('const key = `flashpay:wallet:submit:${sourceAddress}`'), "P7 wallet lock must be keyed by source wallet")
need(lock.includes('redis.set(key, token, { nx: true, ex: SUBMIT_LOCK_TTL_SECONDS })'), "P7 wallet lock must use NX+TTL")
need(lock.includes('if current == ARGV[1] then') && lock.includes('return redis.call("DEL", KEYS[1])'), "P7 release must be token checked")
need(lock.includes('if current ~= ARGV[1] then return 0 end') && lock.includes('return redis.call("EXPIRE", KEYS[1], ARGV[2])'), "P7 renewal must be token checked")
need(lock.includes('claimPiWalletIntent(sourceAddress, owner)'), "P7 lock must bind persistent wallet intent")
need(lock.includes('const INTENT_KEY_PREFIX = "flashpay:wallet:intent:v1:"'), "P7 intent must be source-wallet scoped")

const stage2 = a2u.indexOf('async function stage2SignAndSubmit')
const settlementLock = a2u.indexOf('acquirePiWalletIntentSubmitLock(appPublicKey, { kind: "settlement_claim", paymentId: ctx.paymentId })', stage2)
const settlementMove = a2u.indexOf('moveStage2UnderHeldWalletLock(horizonServer, transaction, preparedHash)', settlementLock)
const settlementDurable = a2u.indexOf('recordSettlementHorizonCheckpoint({', settlementMove)
const settlementFinally = a2u.indexOf('} finally {', settlementDurable)
need(stage2 >= 0 && settlementLock > stage2 && settlementMove > settlementLock && settlementDurable > settlementMove && settlementFinally > settlementDurable, "P7 settlement submit must remain under source-wallet lock through durable Horizon checkpoint")
need(a2u.includes('async function moveStage2UnderHeldWalletLock') && a2u.includes('horizonServer.submitTransaction(transaction)'), "P7 settlement Horizon side effect binding missing")

const freshLock = refund.indexOf("acquirePiWalletIntentSubmitLock(refundPayment.from_address, { kind: 'refund_claim', paymentId: checkpoint.paymentId, refundId })")
const freshSubmit = refund.indexOf("submitRefundBlockchainOnce({ checkpoint: claim.checkpoint, payment: refundPayment })", freshLock)
const freshFinally = refund.indexOf('await walletLock.release()', freshSubmit)
need(freshLock >= 0 && freshSubmit > freshLock && freshFinally > freshSubmit, "P7 fresh refund submit must remain under source-wallet lock")
need(refundSubmit.includes('await server.submitTransaction(transaction)'), "P7 refund Horizon side effect missing")

const replayFn = refund.indexOf('readRefundPreparedReplayUnderExistingOwner')
const replayLock = refund.indexOf('acquirePiWalletSubmitLock(refund.payment.from_address)', replayFn)
const replayEvidence = refund.indexOf('readRefundPreparedRecoveryEvidence', replayLock)
need(replayFn >= 0 && replayLock > replayFn && replayEvidence > replayLock, "P7 prepared refund replay must reread exact evidence under source-wallet lock")

need(locked.includes('acquirePiWalletSubmitLock(latestPayment.a2uFromAddress)'), "P7 settlement recovery submit lock binding missing")

// Deterministic barrier model for two independent instances contending on one source-wallet key.
type State = { token: string | null; intent: string | null; maxInFlight: number; inFlight: number }
const state: State = { token: null, intent: null, maxInFlight: 0, inFlight: 0 }
const acquire = (token: string, owner: string): boolean => {
  if (state.token !== null) return false
  state.token = token
  if (state.intent !== null && state.intent !== owner) { state.token = null; return false }
  state.intent = owner
  state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
  return true
}
const release = (token: string, owner: string): boolean => {
  if (state.token !== token) return false
  state.token = null; state.inFlight -= 1
  if (state.intent === owner) state.intent = null
  return true
}
need(acquire('A-token','payment-A') === true, "P7 model A should acquire")
need(acquire('B-token','payment-B') === false, "P7 model B must be excluded while A owns wallet")
need(state.maxInFlight === 1, "P7 max in-flight wallet submitters must be one")
need(release('stale-token','payment-A') === false && state.token === 'A-token', "P7 stale token must not release current owner")
need(release('A-token','payment-A') === true, "P7 A release failed")
need(acquire('B-token','payment-B') === true, "P7 B must progress after legitimate release")
need(state.maxInFlight === 1, "P7 second round violated serialization")
need(release('B-token','payment-B') === true, "P7 B release failed")

console.log('PLAN_I_P7_SAME_WALLET_CONCURRENCY=PASS max_in_flight=1 source_wallet_key=true token_release=true token_renewal=true settlement_bound=true refund_bound=true')
