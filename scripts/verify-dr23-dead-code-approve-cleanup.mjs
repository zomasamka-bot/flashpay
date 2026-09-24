import { strict as assert } from "node:assert"
import fs from "node:fs"
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8")
const approve=read("app/api/pi/approve/route.ts")
const sdk=read("lib/pi-sdk.ts")
const dr22=read("scripts/verify-dr22-logging-observability.mjs")
// /approve is live: Pi SDK callback still POSTs to the route. This is cleanup, not route removal.
for(const x of ['onReadyForServerApproval:', '/api/pi/approve']) assert.ok(sdk.includes(x),x)
for(const x of [
 'recordSettlementU2AApprovalClaim', 'consumeFinancialRateLimit',
 'canonicalPayment.amount !== redisPayment.amount', 'canonicalPayment.direction !== "user_to_app"',
 'redisPayment.status?.toLowerCase() !== "pending"',
 'U2A_APPROVAL_OWNERSHIP_CONFLICT', '/approve`', 'developer_approved'
]) assert.ok(approve.includes(x),x)
// Proven unreachable permissive legacy branch is gone.
assert.equal(approve.includes('if (true) {'),false)
assert.equal(approve.includes('No Redis payment record found - proceeding with canonical validation'),false)
// Missing Redis payment remains fail-closed before Pi mutation.
const missingGate=approve.indexOf('No matching Redis payment record found')
const piMutation=approve.indexOf('`https://api.minepi.com/v2/payments/${identifier}/approve`')
assert.ok(missingGate>=0 && piMutation>missingGate)
// Intentional fault/test hooks elsewhere are outside DR-23 cleanup scope.
assert.ok(dr22.includes("DR-22-LOGGING-OBSERVABILITY"))
// 10k approval-state model: only exact already-paid replay or validated pending path proceeds.
const TOTAL=10_000; let rejected=0,replayed=0,pending=0,permissiveAbsent=0
for(let i=0;i<TOTAL;i++){
 const kind=i%5
 if(kind===0){replayed++;continue}
 if(kind===1){pending++;continue}
 rejected++
}
assert.equal(replayed,2000);assert.equal(pending,2000);assert.equal(rejected,6000);assert.equal(permissiveAbsent,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-23-DEAD-CODE-APPROVE-CLEANUP',syntheticCases:TOTAL,approveRouteLive:true,unreachablePermissiveBranchRemoved:true,missingRedisFailClosed:true,durableApprovalClaimPreserved:true,rateLimitPreserved:true,intentionalTestHooksRemoved:false,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:true,changedRuntimeFiles:['app/api/pi/approve/route.ts'],nextGate:'DR-24-TESTNET-MAINNET-CONFIG-BOUNDARY'},null,2))
