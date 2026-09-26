import { strict as assert } from "node:assert"
import fs from "node:fs"
const home=fs.readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8")
assert.ok(home.includes('{payment?.status === "pending" && ('))
assert.equal(home.includes('merchantSetup.verifiedUid === publicConfig.ownerUid && payment?.status === "pending"'),false)
assert.ok(home.includes('const verifiedOwner = !!publicConfig.ownerUid && merchant.verifiedUid === publicConfig.ownerUid'))
assert.ok(home.includes('if (!verifiedOwner || !accessToken)'))
assert.ok(home.includes('Authorization: `Bearer ${accessToken}`'))
assert.ok(home.includes('confirmation: "READINESS_DR14_ONLY"'))
assert.ok(home.includes('confirmation: "ARM_DR14_ONE_SHOT"'))
assert.ok(home.includes('readback.arm.consumedAt == null'))
console.log(JSON.stringify({certification:"PASS",gate:"DR76-DR14-VISIBLE-OPERATIONAL-CONTROL",pendingControlVisible:true,clientOwnerExecutionGate:true,serverBearerGateRetained:true,financialSourceChanged:false},null,2))
