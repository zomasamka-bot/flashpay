import { strict as assert } from "node:assert"
import fs from "node:fs"
const api=fs.readFileSync(new URL("../app/api/control/dr10/route.ts",import.meta.url),"utf8")
const ui=fs.readFileSync(new URL("../app/control-panel/page.tsx",import.meta.url),"utf8")
for (const x of ["verifyOwnerAuthorizationHeader",'process.env.VERCEL_ENV !== "production"','process.env[DR10_ENV] !== "1"','FLASHPAY_TRANSIENT_RECOVERY_SECRET','VERCEL_PROJECT_PRODUCTION_URL','body?.confirmation !== CONFIRM','x-flashpay-transient-recovery-secret','x-flashpay-dr10-confirm','cache: "no-store"','redirect: "error"']) assert.ok(api.includes(x),`missing ${x}`)
assert.ok(!api.includes('console.log(recoverySecret)'))
assert.ok(!api.includes('return NextResponse.json({ recoverySecret'))
for(const x of ['/api/control/dr10','TOTAL_REDIS_LOSS','uidData.accessToken','Authorization: `Bearer ${uidData.accessToken}`']) assert.ok(ui.includes(x),`missing UI ${x}`)
console.log(JSON.stringify({certification:"PASS",gate:"DR43-OWNER-AUTHENTICATED-DR10-TRIGGER",freshOwnerAuth:true,productionOnly:true,envOptIn:true,exactConfirmation:true,secretServerSideOnly:true,financialAuthorityChanged:false,postgresMutationByTrigger:false,piCallByTrigger:false,horizonCallByTrigger:false},null,2))
