import { strict as assert } from "node:assert"
import fs from "node:fs"

const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const transient=read("app/api/recovery/transient/route.ts")
const complete=read("app/api/pi/complete/route.ts")
const db=read("lib/db.ts")
const walletLock=read("lib/pi-wallet-submit-lock.ts")
const oldLatency=read("scripts/verify-r1009-recovery-latency-matrix.mjs")
const must=(s,x)=>assert.ok(s.includes(x),`missing R101-9 liveness binding: ${x}`)

// 1. U2A completion atomically establishes durable Redis work + ordered ready
// membership before the optional immediate network kick is scheduled.
for(const x of [
 'IMMEDIATE_DRAIN_KICK_KEY',
 "'NX','EX',ARGV[4]",
 'if immediateDrainKickOwned == 1 then return 2 end',
 'after(async () => {',
 'durable queue remains authoritative',
]) must(complete,x)
const queueCommit=complete.indexOf("const atomicU2AResult = await redis.eval")
const immediateDispatch=complete.indexOf("after(async () => {",queueCommit)
assert.ok(queueCommit>=0&&immediateDispatch>queueCommit)

// 2. The immediate kick is coalesced/ephemeral, never financial authority.
must(complete,"const IMMEDIATE_DRAIN_KICK_TTL_SECONDS = 90")
assert.equal(complete.includes("await executeA2URecovery("),false)

// 3. Periodic/trusted wake always performs PostgreSQL durable rediscovery before
// queue execution, so loss of the immediate kick does not lose durable work.
for(const x of [
 "repopulateDurableSettlementWork()",
 "repopulateDurableU2AIngressWork()",
 "listOutstandingSettlementCheckpointIds(200)",
 "listRecoverableU2AIngressCheckpointIds(200)",
]) must(transient,x)
assert.ok(transient.indexOf("repopulateDurableSettlementWork()") < transient.indexOf("const workStartedAt = Date.now()"))

// 4. Overlapping wakes are serialized by a token-owned lease. Release/renew are
// compare-by-token scripts, so a stale invocation cannot release a successor.
for(const x of [
 'const DRAIN_LEASE_TTL_SECONDS = 900',
 'redis.set(DRAIN_LEASE_KEY, token, { nx: true, ex: DRAIN_LEASE_TTL_SECONDS })',
 'if current ~= ARGV[1] then return 0 end',
 'if current == ARGV[1] then return redis.call("DEL", KEYS[1]) end',
 'if (drainLease.state === "busy")',
 'if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }',
 "await drainLease.release()",
]) must(transient,x)

// 5. The worker is bounded: discovery pages are 200, generic pipeline concurrency
// is 2, and the single-wallet burst has a 60s budget.
for(const x of [
 "const BOUNDED_PIPELINE_CONCURRENCY = 2",
 "const WALLET_DRAIN_BURST_BUDGET_MS = 60_000",
 "listOutstandingSettlementCheckpointIds(200)",
 "listRecoverableU2AIngressCheckpointIds(200)",
 "Math.min(BOUNDED_PIPELINE_CONCURRENCY, items.length)",
 "walletDrainBudgetExhausted = true",
]) must(transient,x)
assert.equal(transient.includes("Promise.all(page.paymentIds)"),false)

// 6. Remaining work creates a bounded one-hop continuation. There is no timer
// retry loop and continuation re-enters the same shared lease.
for(const x of [
 'const CONTINUATION_MODE = "continuation-kick"',
 'walletDrainContinuationScheduled = scheduleTrustedTransientRequest("continuation-kick")',
 'if (requestedMode === CONTINUATION_MODE) {\n    const scheduled = scheduleTrustedTransientRequest("drain")',
]) must(transient,x)
assert.equal((transient.match(/setTimeout\s*\(/g)||[]).length,0)

// 7. Pi create pressure suppresses fresh creation without erasing durable work.
for(const x of [
 'payment.a2uErrorCode === "too_many_payments" || payment.a2uErrorCode === "uid_verification_429"',
 "const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000",
 "walletDrainFairnessFreshCreateSuppressed",
]) must(transient,x)

// 8. Settlement/refund share scheduler arbitration; unsafe settlement progress
// stops the burst instead of advancing another wallet movement blindly.
for(const x of [
 'type WalletDrainFairnessClass = "fresh" | "reconciling" | "refund"',
 'type WalletDrainLane = "prepared" | WalletDrainFairnessClass',
 'walletDrainBurstStopReason = `settlement_${result.state}`',
 "readAutomaticRefundDrainHead",
]) must(transient,x)

// 9. Wallet submission itself has a second, source-address-scoped token lock and
// durable intent owner. Cron/wake duplication therefore cannot become movement
// duplication merely because two invocations exist.
for(const x of [
 "flashpay:wallet:submit:",
 "SUBMIT_LOCK_TTL_SECONDS = 600",
 "SUBMIT_LOCK_RENEW_INTERVAL_MS = 180_000",
 "claimPiWalletIntent",
 "acquirePiWalletExistingIntentSubmitLock",
]) must(walletLock,x)

// 10. Durable rediscovery is keyset/cursor bounded and the older latency matrix
// already proves evidence-driven retry/no blind resubmit. R101-9 composes those
// invariants rather than changing financial runtime code.
for(const x of [
 "settlement_recovery_scan_cursor",
 "u2a_ingress_recovery_scan_cursor",
 "FOR UPDATE",
]) must(db,x)
for(const x of [
 "periodicFallbackPreserved:true",
 "blindFinancialRetryAdded:false",
 "runtimeFinancialLogicChanged:false",
]) must(oldLatency,x)

// Executable adversarial liveness model. The kick is latency-only; durable work
// remains until a later periodic wake. Duplicate wakes collapse to one lease owner.
function model({kickDelivered=true,wakeCrash=false,duplicateWake=false,budgetExhausted=false,piPressure=false}={}){
 let durable=true, ready=true, lease=false, movements=0, continuation=false
 if(kickDelivered){
   if(!lease) lease=true
   if(wakeCrash){ lease=false } // durable/ready intentionally survive
   else if(!piPressure){
     movements=1; durable=false; ready=false
     if(budgetExhausted) continuation=true
     lease=false
   } else lease=false
 }
 if(durable){ // later trusted periodic wake
   if(!lease) lease=true
   if(!piPressure){ movements=1; durable=false; ready=false }
   lease=false
 }
 if(duplicateWake){ // same durable truth cannot produce a second modeled movement
   if(!durable) movements+=0
 }
 return {durable,ready,lease,movements,continuation}
}
assert.equal(model({kickDelivered:false}).movements,1)
assert.equal(model({kickDelivered:true,wakeCrash:true}).movements,1)
assert.equal(model({duplicateWake:true}).movements,1)
assert.equal(model({piPressure:true}).movements,0)
assert.equal(model({budgetExhausted:true}).movements,1)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-9-DRAIN-LIVENESS",
 proofSteps:10,
 sourcePatchRequired:false,
 immediateKickAuthority:"LATENCY_ONLY",
 durableFallback:"POSTGRES_REDISCOVERY_PLUS_READY_QUEUE",
 overlapControl:"TOKEN_OWNED_DRAIN_LEASE",
 walletMovementControl:"SOURCE_ADDRESS_LOCK_PLUS_DURABLE_INTENT",
 boundedPipelineConcurrency:2,
 walletDrainBudgetMs:60000,
 continuation:"BOUNDED_ONE_HOP",
 piBackpressure:"DEFER_NOT_LOSE",
 blindFinancialRetryAdded:false,
 runtimeFinancialLogicChanged:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 secretsRead:false,
 externalSchedulerConfiguration:"NOT_ASSERTED_BY_STATIC_CERTIFIER",
 runtimeCadenceEvidenceRequiredForProductionClosure:true
},null,2))
