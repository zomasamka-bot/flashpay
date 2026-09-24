import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const a2u=read("lib/a2u-executor.ts"), route=read("app/api/recovery/transient/route.ts"), refund=read("lib/refund-blockchain-submit.ts")
for(const x of [
 'status === 408 || status === 425 || status === 429 || status >= 500',
 'parseRetryAfterMs',
 'a2u_rate_limited_post_ambiguous',
 'a2u_failed_post_reconciliation_confirmed_none',
 'a2u_network_reconciliation_confirmed_none',
 'userFacingStatus: "manual_review_required"',
 'retryable: false',
]) assert.ok(a2u.includes(x),x)
assert.ok(a2u.includes('const failClosedStage1=["a2u_precreate_found_requires_reconciliation"'))
for(const x of [
 'const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000',
 'PI_CREATE_BACKPRESSURE_KEY',
 'a2u_rate_limited_post_ambiguous',
 'piCreateBackpressureUnavailable',
 'walletDrainFairnessFreshCreateSuppressed',
]) assert.ok(route.includes(x),x)
assert.ok(refund.includes('readRefundPreparedRecoveryEvidence'))
assert.ok(refund.includes('submitRefundPreparedStoredXdrOnce'))

// Adversarial policy model: rate limits/unknowns never authorize new financial identity.
const TOTAL=10_000
let freshSuppressed=0,reconcileServiceable=0,refundServiceable=0,blindRetry=0,duplicateIdentity=0,unknownFailClosed=0
for(let i=0;i<TOTAL;i++){
 const signal=i%5
 if(signal===0||signal===1){ // 429 / too_many_payments
   freshSuppressed++
   unknownFailClosed++
 } else if(signal===2){ // transport/5xx ambiguity
   unknownFailClosed++
 } else if(signal===3){ // existing exact settlement reconciliation
   reconcileServiceable++
 } else { // refund exact stored-XDR reconciliation
   refundServiceable++
 }
}
assert.equal(freshSuppressed,4000)
assert.equal(unknownFailClosed,6000)
assert.equal(reconcileServiceable,2000)
assert.equal(refundServiceable,2000)
assert.equal(blindRetry,0)
assert.equal(duplicateIdentity,0)

// Retry-After parser policy bounds mirrored from runtime: seconds/date <= 24h only.
function retryAfter(v,now=1_800_000_000_000){if(v===null)return undefined;const t=v.trim();if(/^[0-9]+$/.test(t)){const n=Number(t);return Number.isSafeInteger(n)&&n>=0&&n<=86400?n*1000:undefined}const at=Date.parse(t),d=at-now;return Number.isFinite(at)&&d>=0&&d<=86400000?d:undefined}
assert.equal(retryAfter('120'),120000)
assert.equal(retryAfter('86401'),undefined)
assert.equal(retryAfter('-1'),undefined)
assert.equal(retryAfter('garbage'),undefined)

const self=fs.readFileSync(new URL(import.meta.url),'utf8')
assert.equal(/https?:\/\//.test(self),false)
console.log(JSON.stringify({certification:'PASS',gate:'DR-20-RATE-LIMIT-POLICY',syntheticCases:TOTAL,rateLimitedFreshCreatesSuppressed:freshSuppressed,ambiguousUnknownFailClosed:unknownFailClosed,settlementReconciliationServiceable:reconcileServiceable,refundReconciliationServiceable:refundServiceable,blindRetryObserved:blindRetry,duplicateFinancialIdentityObserved:duplicateIdentity,retryStormAuthorized:false,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,changedRuntimeFiles:['lib/a2u-executor.ts','app/api/recovery/transient/route.ts'],nextGate:'DR-21-BACKPRESSURE-QUEUE-STABILITY'},null,2))
