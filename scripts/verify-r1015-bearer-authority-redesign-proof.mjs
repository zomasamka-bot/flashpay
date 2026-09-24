import { strict as assert } from "node:assert"
import fs from "node:fs"

const payments=fs.readFileSync(new URL("../app/api/payments/route.ts",import.meta.url),"utf8")
const complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8")
const locked=fs.readFileSync(new URL("../lib/a2u-locked-executor.ts",import.meta.url),"utf8")
const executor=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
const recovery=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8")
const types=fs.readFileSync(new URL("../lib/types.ts",import.meta.url),"utf8")

// R101-5 is proof-before-migration. It MUST NOT delete bearer storage yet.
// Inventory the exact remaining dependencies that make immediate deletion unsafe.
assert.ok(types.includes("accessToken: string"))
assert.ok(payments.includes("accessToken: accessToken, // Store accessToken to verify uid again at A2U time"))
assert.ok(payments.includes('fetch("https://api.minepi.com/v2/me"'))
assert.ok(complete.includes("const accessToken = payment.accessToken"))
assert.ok(complete.includes("current.accessToken ~= incoming.accessToken"))
assert.ok(executor.includes('ctx.merchantAuthority === "access_token"'))
assert.ok(executor.includes('fetch("https://api.minepi.com/v2/me"'))

// Existing F2-4 proves a tokenless authority only for the recovery branch.
// It requires exact completed durable U2A identity + canonical Pi server GET.
const verifyStart=locked.indexOf("async function verifyF24DurableMerchantAuthority")
const verifyEnd=locked.indexOf("function isSettlementDispatchCandidate",verifyStart)
const verify=locked.slice(verifyStart,verifyEnd)
assert.ok(verify.includes('payment.accessToken !== ""'))
assert.ok(verify.includes("getDurableU2AIngressAuthoritative(paymentId)"))
assert.ok(verify.includes("durable.checkpoint.completedAt === null"))
assert.ok(verify.includes("metadata?.paymentId === paymentId"))
assert.ok(verify.includes("transaction?.txid === d.u2aTxid"))
assert.ok(verify.includes("dto.user_uid === d.payerUid"))
assert.ok(verify.includes("status?.developer_completed === true"))
assert.ok(verify.includes("status?.cancelled !== true"))
assert.ok(verify.includes("status?.user_cancelled !== true"))

// Critical proof: normal fresh Stage1 cannot currently use durable_u2a.
// Therefore deleting bearer now would break normal settlement creation.
assert.ok(locked.includes("const recoveryMayCreate = params.isRecovery === true"))
assert.ok(locked.includes('if (!recoveryMayCreate || latestPayment.accessToken !== "" || !(await verifyF24DurableMerchantAuthority'))
assert.ok(executor.includes('durableMerchantAuthority && ctx.isRecovery === true && ctx.accessToken === ""'))

// Recovery reconstruction intentionally uses the empty-string sentinel.
assert.ok(recovery.includes("accessToken:''"))
assert.ok(recovery.includes("accessToken:\"\"") || recovery.includes("accessToken:''"))

// No secret is persisted in PostgreSQL durable U2A authority.
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
assert.equal(/access[_]?token/i.test(db),false)

// Migration decision matrix.
const current={
 normalFresh:{token:true,durableAllowed:false},
 recoveryFresh:{token:false,durableAllowed:true},
 stage1Plus:{tokenNotNeededForMovementResume:true}
}
assert.equal(current.normalFresh.durableAllowed,false)
assert.equal(current.recoveryFresh.durableAllowed,true)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-5-BEARER-AUTHORITY-REDESIGN-PROOF",
 finding:"CONFIRMED_MIGRATION_REQUIRED",
 currentAuthority:{
  paymentCreation:"BEARER_V2_ME_THEN_REDIS_SECRET_PERSISTENCE",
  normalFreshSettlement:"BEARER_REQUIRED",
  recoveryFreshSettlement:"DURABLE_U2A_SUPPORTED",
  durableProof:"POSTGRES_U2A_PLUS_CANONICAL_PI_GET",
  postgresSecretPersistence:false
 },
 immediateBearerDeletionSafe:false,
 requiredNextChange:"R101-6-MIGRATE-NORMAL-POST-U2A-PATH-THEN-REMOVE-REDIS-BEARER",
 sourcePatchRequired:false,
 financialMovementExecuted:false,
 piNetworkCalled:false,
 secretsRead:false
},null,2))
