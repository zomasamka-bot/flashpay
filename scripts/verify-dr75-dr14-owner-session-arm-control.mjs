import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const home=fs.readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8')
for(const x of [
'import { unifiedStore } from "@/lib/unified-store"',
'import { publicConfig } from "@/lib/public-config"',
'merchant.verifiedUid === publicConfig.ownerUid',
'merchantSetup.verifiedUid === publicConfig.ownerUid',
'confirmation: "READINESS_DR14_ONLY"',
'confirmation: "ARM_DR14_ONE_SHOT"',
'Authorization: `Bearer ${accessToken}`',
'readback.arm.consumedAt == null',
'Date.parse(readback.arm.expiresAt) > Date.now()',
'setDr14Armed(true)'
]) assert.ok(home.includes(x),x)
assert.ok(home.indexOf('confirmation: "READINESS_DR14_ONLY"') < home.indexOf('confirmation: "ARM_DR14_ONE_SHOT"'))
assert.ok(home.indexOf('confirmation: "ARM_DR14_ONE_SHOT"') < home.indexOf('readbackResponse = await fetch'))
assert.equal(/paymentId=.*accessToken/.test(home),false)
assert.equal(/JSON\.stringify\([^)]*accessToken/.test(home),false)
for(const forbidden of ['executeA2U','executeRefund','submitRefundBlockchainOnce','Pi.createPayment']) assert.equal(home.includes(forbidden),false,forbidden)
console.log(JSON.stringify({certification:'PASS',gate:'DR75-DR14-OWNER-SESSION-ARM-CONTROL',verifiedOwnerUid:true,readinessBeforeArm:true,authenticatedReadback:true,tokenInUrl:false,tokenInBody:false,financialExecutionStarted:false},null,2))
