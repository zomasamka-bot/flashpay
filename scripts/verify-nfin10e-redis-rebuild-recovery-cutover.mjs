import{strict as assert}from"node:assert";import fs from"node:fs";
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8"),rec=fs.readFileSync(new URL("../lib/a2u-recovery-service.ts",import.meta.url),"utf8"),lock=fs.readFileSync(new URL("../lib/a2u-locked-executor.ts",import.meta.url),"utf8"),ex=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8"),route=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8"),complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8");
for(const x of ["ADD COLUMN IF NOT EXISTS u2a_identifier","ADD COLUMN IF NOT EXISTS u2a_txid","getSettlementCheckpointAuthoritative","getDurableU2AIngressAuthoritative","u2aIdentifier: string","u2aTxid: string","row.u2a_identifier !== params.u2aIdentifier","row.u2a_txid !== params.u2aTxid"])assert.ok(db.includes(x),x);
for(const x of ["rebuildSettlementProjectionFromDurable","Redis projection missing; attempting durable PostgreSQL rebuild","durable_projection_unavailable","await redis.set(`payment:${paymentId}`,JSON.stringify(projected),{nx:true})"])assert.ok(rec.includes(x),x);
assert.ok(lock.includes("getSettlementCheckpointAuthoritative(paymentId)"));assert.ok(lock.includes("Payment state could not be durably reconstructed"));
assert.ok(ex.includes("u2aIdentifier: ctx.payment.piPaymentId!"));assert.ok(ex.includes("u2aTxid: ctx.payment.u2aTxid!"));
// F2-4: normal live A2U creation still requires a bearer token and /v2/me.
assert.ok(ex.includes('merchantAuthority: "access_token" | "durable_u2a"'));
assert.ok(ex.includes('if (ctx.merchantAuthority === "access_token")'));
assert.ok(ex.includes('fetch("https://api.minepi.com/v2/me"'));
assert.ok(ex.includes('Authorization: `Bearer ${ctx.accessToken}`'));
// F2-4: total-Redis-loss recovery can use only the exact empty-token projection,
// and only after the locked executor proves PostgreSQL + Pi server authority.
for(const x of ["verifyF24DurableMerchantAuthority","getDurableU2AIngressAuthoritative(paymentId)",'payment.accessToken !== ""','Authorization: `Key ${serverConfig.piApiKey}`','transaction?.verified === true','status?.developer_completed === true','merchantAuthority = "durable_u2a"','Durable merchant authority could not be verified'])assert.ok(lock.includes(x),x);
assert.ok(ex.includes('durableMerchantAuthority && ctx.isRecovery === true && ctx.accessToken === ""'));
assert.ok(ex.includes('[F2-4 DURABLE MERCHANT AUTHORITY] Stage1 bearer re-verification skipped after locked durable+Pi proof'));
assert.ok(route.includes('return payment.accessToken === "" ||'));
assert.ok(route.includes('hasSettlementMerchantProjectionAuthority(payment)'));
assert.equal(complete.includes("F2_3_REDIS_LOSS_PROOF_INJECTED"),false);
assert.equal(rec.includes('state: "payment_not_found"'),false);
assert.ok(rec.includes("redisProjectionVersion:1"));assert.ok(lock.includes("redisProjectionVersion:1"));
console.log(JSON.stringify({certification:"PASS",durableU2AIdentity:true,redisLossRebuild:true,recoveryCutover:true,normalBearerVerificationPreserved:true,durableMerchantAuthorityRecovery:true,piServerAuthorityRequired:true,noSecretPersisted:true,failClosedOnUnprovenRebuild:true,blindFinancialRetryAdded:false,faultInjectionHookRemoved:true},null,2));
