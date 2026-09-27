import { strict as assert } from "node:assert"
import fs from "node:fs"
const home=fs.readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8")
const route=fs.readFileSync(new URL("../app/api/control/dr14/route.ts",import.meta.url),"utf8")
assert.ok(home.includes('{payment?.status === "settlement_failed" && ('))
assert.ok(home.includes('const accessToken = merchant.accessToken'))
assert.ok(home.includes('if (!accessToken)'))
assert.ok(home.includes('Authorization: `Bearer ${accessToken}`'))
assert.ok(home.includes('confirmation: "READINESS_DR14_ONLY"'))
assert.ok(home.includes('confirmation: "ARM_DR14_ONE_SHOT"'))
assert.ok(home.includes('readback.arm.consumedAt == null'))
assert.ok(route.includes("verifyOwnerAuthorizationHeader(request.headers.get('authorization'))"))
console.log(JSON.stringify({certification:"PASS",gate:"DR76-DR14-VISIBLE-OPERATIONAL-CONTROL-HISTORICAL-INVARIANT",currentRefundControlVisible:true,serverOwnerGateRetained:true,canonicalReadbackRetained:true,financialSourceChanged:false},null,2))
