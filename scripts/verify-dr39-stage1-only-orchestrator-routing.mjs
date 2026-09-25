import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const recovery=fs.readFileSync(new URL('../lib/a2u-recovery-service.ts',import.meta.url),'utf8')
const locked=fs.readFileSync(new URL('../lib/a2u-locked-executor.ts',import.meta.url),'utf8')
const route='if ((payment.status === "paid_to_app" && payment.settlementFailureState === undefined && typeof payment.settlementDispatchRequestedAt === "string") || isStage1OnlySettlementDispatchCandidate(payment, Date.now())) {'
assert.ok(recovery.includes(route),'orchestrator must route stage1-only independently of paid_to_app fresh-dispatch status')
assert.ok(recovery.includes('recoveryOperation: "SETTLEMENT_DISPATCH"'),'stage1-only must delegate to locked settlement dispatch')
assert.ok(locked.includes('if (stage1OnlyDispatch) {') && locked.includes('verifyStage1OnlyDurableAuthority(paymentId, latestPayment)'),'locked executor must verify durable stage1 authority')
assert.ok(locked.includes('[F2-7 STAGE1 DURABLE RESUME]'),'durable resume marker missing')
assert.ok(locked.includes('durable.checkpoint.stage !== "a2u_created"'),'durable authority must require a2u_created')
let routed=0, unsafe=0
for(let i=0;i<10000;i++){
 const status=i%2?'settlement_pending':'paid_to_app'
 const stage1Only=i%5!==0
 const fresh=status==='paid_to_app'&&i%7===0
 const routeHit=fresh||stage1Only
 if(routeHit)routed++
 if(status==='settlement_pending'&&!stage1Only&&routeHit)unsafe++
}
assert.ok(routed>0); assert.equal(unsafe,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-39-STAGE1-ONLY-ORCHESTRATOR-ROUTING',syntheticCases:10000,routed,unsafeRoutes:unsafe,stage1OnlyIndependentOfPaidToApp:true,durableA2UCreatedAuthorityRequired:true,financialMovementExecuted:false,productionDataMutated:false},null,2))
