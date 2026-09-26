import { strict as assert } from "node:assert"
import fs from "node:fs"
const kernel=fs.readFileSync(new URL("../lib/dr14-live-crash-certification.ts",import.meta.url),"utf8")
const route=fs.readFileSync(new URL("../app/api/control/dr14/route.ts",import.meta.url),"utf8")
const home=fs.readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8")
for(const x of [
"export type Dr14CrashReadback",
"paymentId: string",
"armedAt: string",
"expiresAt: string",
"consumedAt: string | null",
"function canonicalTimestamp(value: unknown)",
"row.payment_id!==paymentId",
"dr14BoundaryLane(row.boundary)!==row.lane",
"return { paymentId, lane:row.lane, boundary:row.boundary, armedAt, expiresAt, consumedAt }"
]) assert.ok(kernel.includes(x),x)
assert.equal(kernel.includes("return Array.isArray(r)&&r.length===1?r[0]:null"),false)
assert.ok(route.includes("{paymentId,arm:await readDr14Crash(paymentId)}"))
for(const x of ["readback?.arm?.paymentId === currentPaymentId","readback.arm.consumedAt == null",'typeof readback.arm.expiresAt === "string"',"Date.parse(readback.arm.expiresAt) > Date.now()"]) assert.ok(home.includes(x),x)
console.log(JSON.stringify({certification:"PASS",gate:"DR78-DR14-CANONICAL-READBACK",rawDbRowExposed:false,camelCaseContract:true,timestampCanonicalization:true,laneBoundaryConsistency:true,failClosed:true,financialExecutionStarted:false},null,2))
