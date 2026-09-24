import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const complete=read("app/api/pi/complete/route.ts")
const sdk=read("lib/pi-sdk.ts")
const internal=read("app/api/pi/a2u/route.ts")
const cfg=read("lib/server-config.ts")

// Contract proof: both live Pi SDK completion and incomplete-payment recovery
// are browser callbacks carrying only canonical Pi identifiers; no server secret.
const browserCompleteCalls=[...sdk.matchAll(/fetch\(`\$\{config\.appUrl\}\/api\/pi\/complete`,\s*\{([\s\S]*?)\n\s*\}\)/g)]
assert.ok(browserCompleteCalls.length >= 3, "expected live + incomplete browser completion callers")
for(const m of browserCompleteCalls){
  const call=m[1]
  assert.ok(call.includes('"Content-Type": "application/json"'))
  assert.ok(call.includes("JSON.stringify({ piPaymentId, txid })"))
  assert.equal(call.includes("x-flashpay-internal-secret"),false)
  assert.equal(call.includes("A2U_INTERNAL_SECRET"),false)
}

// The browser-facing route must not pretend the unrelated internal A2U secret
// authenticates the callback. It must still fail closed on actual server proof.
assert.equal(complete.includes("serverConfig.a2uInternalSecret"),false)
assert.equal(/serverConfig\.a2uInternalSecret|process\.env\.A2U_INTERNAL_SECRET/.test(complete),false)
for(const x of [
 "serverConfig.isPiApiKeyConfigured",
 'Authorization": `Key ${serverConfig.piApiKey}`',
 "piPayment.identifier !== piPaymentId",
 'piPayment.direction !== "user_to_app"',
 "piPayment.status?.cancelled === true",
 "piPayment.status?.developer_approved !== true",
 "piPayment.status?.transaction_verified !== true",
 "canonicalTxid !== txid",
 "piPayment.metadata?.paymentId",
 "recordSettlementU2AVerifiedCheckpoint({",
 "recordSettlementU2ACompletedCheckpoint({"
]) assert.ok(complete.includes(x),x)

// Internal A2U remains truly secret-authenticated with timing-safe equality.
for(const x of [
 'request.headers.get("x-flashpay-internal-secret")',
 "serverConfig.a2uInternalSecret",
 "timingSafeEqual(secretBuffer, providedBuffer)",
 'return NextResponse.json({ error: "Unauthorized" }, { status: 401 })'
]) assert.ok(internal.includes(x),x)
assert.ok(cfg.includes("used only to secure internal A2U routes; never required by browser callbacks"))

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-7-COMPLETE-AUTHENTICATION-SEMANTICS",
 completeCallerContract:"PI_SDK_BROWSER_CALLBACK",
 browserInternalSecretRequired:false,
 canonicalPiServerVerificationRequired:true,
 durableU2ABindingRequired:true,
 internalA2USecretAuthenticationPreserved:true,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 secretsRead:false
},null,2))
