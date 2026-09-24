import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const payments=read("app/api/payments/route.ts"),complete=read("app/api/pi/complete/route.ts")
const locked=read("lib/a2u-locked-executor.ts"),executor=read("lib/a2u-executor.ts")
const db=read("lib/db.ts"),types=read("lib/types.ts")

// Merchant authentication still occurs at payment creation, but the bearer dies
// with that request and is never copied into the Payment Redis projection.
assert.ok(payments.includes('fetch("https://api.minepi.com/v2/me"'))
assert.ok(payments.includes('Authorization: `Bearer ${accessToken}`'))
assert.equal(payments.includes("accessToken: accessToken"),false)
assert.ok(types.includes("accessToken?: string // R101-6 legacy Redis compatibility only"))

// /complete authenticates financial truth with Pi server key + exact durable
// identity; it neither requires, compares, nor re-persists the merchant bearer.
assert.equal(complete.includes("accessToken"),false)
assert.ok(complete.includes("recordSettlementU2AVerifiedCheckpoint({"))
assert.ok(complete.includes("recordSettlementU2ACompletedCheckpoint({"))

// Fresh A2U Stage1 authority is now identical to the already-proven recovery
// authority: completed PostgreSQL U2A identity + exact canonical Pi GET.
const verify=locked.slice(locked.indexOf("async function verifyF24DurableMerchantAuthority"),locked.indexOf("function isSettlementDispatchCandidate"))
for(const x of [
 "getDurableU2AIngressAuthoritative(paymentId)",
 "durable.checkpoint.completedAt === null",
 "payment.merchantId !== d.merchantId",
 "payment.merchantUid !== d.merchantUid",
 "payment.piPaymentId !== d.u2aIdentifier",
 "payment.u2aTxid !== d.u2aTxid",
 "payment.payerUid !== d.payerUid",
 'Authorization: `Key ${serverConfig.piApiKey}`',
 "dto.identifier === d.u2aIdentifier",
 'dto.direction === "user_to_app"',
 "dto.amount === d.customerAmount",
 "dto.user_uid === d.payerUid",
 "metadata?.paymentId === paymentId",
 "transaction?.txid === d.u2aTxid",
 "transaction?.verified === true",
 "status?.developer_approved === true",
 "status?.transaction_verified === true",
 "status?.developer_completed === true",
 "status?.cancelled !== true",
 "status?.user_cancelled !== true"
]) assert.ok(verify.includes(x),x)

assert.ok(locked.includes('let merchantAuthority: "durable_u2a" = "durable_u2a"'))
assert.ok(locked.includes('if (!latestPayment.a2uPaymentId && !(await verifyF24DurableMerchantAuthority(paymentId, latestPayment)))'))
assert.ok(locked.includes('recoveryOperation: params.recoveryOperation ?? "normal"'))
assert.equal(locked.includes('merchantAuthority === "access_token"'),false)

// Executor can create only after upstream durable proof; no bearer branch remains.
assert.ok(executor.includes('merchantAuthority: "durable_u2a"'))
assert.equal(executor.includes('merchantAuthority: "access_token"'),false)
assert.equal(executor.includes('/v2/me'),false)
assert.equal(executor.includes('Bearer ${ctx.accessToken}'),false)
assert.ok(executor.includes('if (ctx.merchantAuthority !== "durable_u2a")'))
assert.ok(executor.includes('Authorization: `Key ${serverConfig.piApiKey}`'))

// Durable DB never stores bearer material.
assert.equal(/access[_]?token/i.test(db),false)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-6-NORMAL-DURABLE-AUTHORITY-SECRET-MINIMIZATION",
 freshPaymentBearerPersisted:false,
 completeBearerDependency:false,
 normalPostU2AAuthority:"DURABLE_POSTGRES_PLUS_CANONICAL_PI",
 recoveryAuthority:"DURABLE_POSTGRES_PLUS_CANONICAL_PI",
 legacyBearerProjection:"TOLERATED_NOT_CONSULTED",
 postgresBearerPersistence:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 secretsRead:false
},null,2))
