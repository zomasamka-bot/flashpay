import { strict as assert } from "node:assert"
import fs from "node:fs"
const payments=fs.readFileSync(new URL("../app/api/payments/route.ts",import.meta.url),"utf8")
const complete=fs.readFileSync(new URL("../app/api/pi/complete/route.ts",import.meta.url),"utf8")
const locked=fs.readFileSync(new URL("../lib/a2u-locked-executor.ts",import.meta.url),"utf8")
const executor=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
const types=fs.readFileSync(new URL("../lib/types.ts",import.meta.url),"utf8")
const migrated=types.includes("R101-6 legacy Redis compatibility only")
if(!migrated){
 assert.ok(types.includes("accessToken: string"))
 assert.ok(payments.includes("accessToken: accessToken"))
 assert.ok(complete.includes("current.accessToken ~= incoming.accessToken"))
 assert.ok(executor.includes('ctx.merchantAuthority === "access_token"'))
 console.log(JSON.stringify({certification:"PASS",gate:"R101-5-BEARER-AUTHORITY-REDESIGN-PROOF",finding:"CONFIRMED_MIGRATION_REQUIRED"},null,2))
}else{
 assert.equal(payments.includes("accessToken: accessToken"),false)
 assert.equal(complete.includes("accessToken"),false)
 assert.equal(executor.includes('/v2/me'),false)
 assert.ok(locked.includes("verifyF24DurableMerchantAuthority"))
 console.log(JSON.stringify({certification:"PASS",gate:"R101-5-BEARER-AUTHORITY-REDESIGN-PROOF",finding:"CONFIRMED_AND_MIGRATED_BY_R101_6"},null,2))
}
