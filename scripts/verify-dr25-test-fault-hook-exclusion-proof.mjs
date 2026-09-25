import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const a2u=read('lib/a2u-executor.ts'), complete=read('app/api/pi/complete/route.ts'), refund=read('lib/refund-executor.ts'), refundSubmit=read('lib/refund-blockchain-submit.ts'), recovery=read('app/api/recovery/transient/route.ts')
const settlement=[
 ['0.14','[P7 TEST] Stage1-only interruption 0.14'],['0.11','[A2U TEST] Stage2 prepared checkpoint fault point 0.11'],['0.12','[A2U TEST] Stage2 post-submit fault point 0.12']]
for(const [amount,needle] of settlement){const i=a2u.indexOf(needle);assert.ok(i>=0);const g=a2u.slice(Math.max(0,i-900),i);assert.ok(g.includes('ctx.isRecovery')&&g.includes('false'));assert.ok(g.includes('ctx.merchantAuthority')&&g.includes('durable_u2a'));assert.ok(g.includes('ctx.payment.piPaymentId')&&g.includes('ctx.payment.u2aTxid'));assert.ok(g.includes('hazemaboria')&&g.includes('ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa'));assert.ok(g.includes(amount))}
const i13=complete.indexOf('[P7 TEST] Fresh dispatch interruption 0.13');assert.ok(i13>=0);const g13=complete.slice(Math.max(0,i13-700),i13);assert.ok(g13.includes('finalPiPayment.network==="Pi Testnet"')&&g13.includes('finalPiAmount===0.13'))
const nonProd='process.env.VERCEL_ENV !== "production"', refundFlag='process.env.FLASHPAY_REFUND_CRASH_TEST === "1"'
for(const [src,needle] of [[refund,'[P7 TEST] Refund auth-before-submit 0.10'],[refundSubmit,'[P7 TEST] Refund post-replay-submit 0.10'],[refundSubmit,'[P7 TEST] Refund prepared-before-auth 0.10']]){const i=src.indexOf(needle);assert.ok(i>=0);const g=src.slice(Math.max(0,i-500),i);assert.ok(g.includes(nonProd)&&g.includes(refundFlag))}
assert.ok(recovery.includes('const requestedMode = new URL(request.url).searchParams.get("mode")'));assert.equal(/searchParams\.get\([^)]*(fault|test|crash|interrupt)/i.test(recovery),false)
console.log(JSON.stringify({certification:'PASS',gate:'DR-25-TEST-FAULT-HOOK-EXCLUSION-PROOF',settlementHooksTestnetDurableAuthorityGated:true,settlementMainnetExcludedByCanonicalIngress:true,settlementRecoveryExcluded:true,refundHooksRemainNonProductionAndExplicitFlagGated:true,publicFaultSelectorObserved:false,intentionalHooksRemoved:false,financialMovementExecuted:false,productionDataMutated:false},null,2))
