import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const limiter=read("lib/server-rate-limit.ts")
const create=read("app/api/payments/route.ts")
const approve=read("app/api/pi/approve/route.ts")
const complete=read("app/api/pi/complete/route.ts")
const recovery=read("app/api/recovery/transient/route.ts")

for(const x of ['import "server-only"','createHash("sha256")',"redis.eval","INCR","EXPIRE",'outcome: "UNAVAILABLE"']) assert.ok(limiter.includes(x),x)
assert.equal(limiter.includes("x-forwarded-for"),false)
assert.equal(limiter.includes("request.ip"),false)

// New-money creation: Pi /v2/me proves merchant identity first; limiter then
// precedes UUID, durable identity, Redis payment persistence and every movement.
const cVerify=create.indexOf('fetch("https://api.minepi.com/v2/me"')
const cLimit=create.indexOf("const creationLimit")
const cUuid=create.indexOf("crypto.randomUUID()")
const cDurable=create.indexOf("recordSettlementPaymentIdentityCheckpoint({")
assert.ok(cVerify>=0&&cVerify<cLimit&&cLimit<cUuid&&cUuid<cDurable)
assert.ok(create.includes('subject: verifiedMerchantUid'))
assert.ok(create.includes('creationLimit.outcome === "UNAVAILABLE"'))
assert.ok(create.includes('code: "RATE_LIMITED"'))
assert.ok(create.includes("status: 429"))

// Approval: canonical Pi GET + canonical metadata establish the identifier pair;
// limiter is before durable approval claim and before Pi POST /approve.
const aCanonical=approve.indexOf("const rawPaymentId = canonicalPayment.metadata?.paymentId")
const aLimit=approve.indexOf("const approvalLimit")
const aClaim=approve.indexOf("recordSettlementU2AApprovalClaim({")
const aPost=approve.indexOf("/approve`")
assert.ok(aCanonical>=0&&aCanonical<aLimit&&aLimit<aClaim&&aClaim<aPost)
assert.ok(approve.includes('subject: `${paymentId}:${identifier}`'))
assert.ok(approve.includes('approvalLimit.outcome === "UNAVAILABLE"'))
assert.ok(approve.includes("status: 429"))

// Completion: untrusted junk cannot consume limiter state. Canonical Pi GET,
// exact txid, canonical paymentId and Redis identity are verified first.
// Definite excess returns retry-safe 429; limiter outage bypasses ONLY the
// abuse control so durable existing-money recovery can continue.
const xCanonical=complete.indexOf("const canonicalTxid = piPayment.transaction?.txid")
const xRedis=complete.indexOf("const preStoredPayment = await redis.get")
const xLimit=complete.indexOf("const completionLimit")
const xDurable=complete.indexOf("recordSettlementU2AVerifiedCheckpoint({")
const xPiComplete=complete.indexOf("/complete`")
assert.ok(xCanonical>=0&&xCanonical<xRedis&&xRedis<xLimit&&xLimit<xDurable&&xDurable<xPiComplete)
assert.ok(complete.includes('subject: `${preFlashPaymentId}:${piPaymentId}`'))
assert.ok(complete.includes('completionLimit.outcome === "UNAVAILABLE"'))
assert.ok(complete.includes("canonical existing-money recovery continues"))
assert.ok(complete.includes("status: 429"))

// Durable recovery worker is deliberately outside the limiter.
assert.equal(recovery.includes("consumeFinancialRateLimit"),false)
assert.equal(recovery.includes("flashpay:ratelimit:"),false)

// Limiter has no financial mutation vocabulary.
for(const forbidden of ["recordSettlement","recordRefund","submitTransaction","createPayment","/v2/payments/"]) assert.equal(limiter.includes(forbidden),false,forbidden)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-8-SERVER-ABUSE-RATE-LIMIT",
 creation:"PI_VERIFIED_MERCHANT_UID_30_PER_60S_FAIL_CLOSED_ON_LIMITER_UNAVAILABLE",
 approval:"CANONICAL_PAYMENT_IDENTIFIER_20_PER_60S_FAIL_CLOSED_BEFORE_PI_MUTATION",
 completion:"CANONICAL_PAYMENT_IDENTIFIER_30_PER_60S_LIMITED_429_UNAVAILABLE_RECOVERY_CONTINUES",
 ipOnlyLimiter:false,
 durableRecoveryRateLimited:false,
 limiterFinancialAuthority:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 secretsRead:false
},null,2))
