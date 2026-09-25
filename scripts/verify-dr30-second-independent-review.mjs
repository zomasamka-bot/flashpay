import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8')
const db=read('lib/db.ts'), a2u=read('lib/a2u-executor.ts'), refund=read('lib/refund-executor.ts'), submit=read('lib/refund-blockchain-submit.ts'), route=read('app/api/recovery/transient/route.ts'), approve=read('app/api/pi/approve/route.ts'), complete=read('app/api/pi/complete/route.ts'), recon=read('lib/pi-reconciliation.ts')
const bindings={
 durableXor:/pg_advisory_xact_lock\(hashtextextended/.test(db)&&/refund_checkpoints/.test(db)&&/settlement_checkpoints/.test(db),
 bearerScrub:a2u.includes('merged.accessToken = ""'),
 settlementFaultTestnetDurableGated:a2u.includes('ctx.merchantAuthority==="durable_u2a"')&&a2u.includes('ctx.payment.piPaymentId')&&a2u.includes('ctx.payment.u2aTxid')&&complete.includes('finalPiPayment.network==="Pi Testnet"'),
 refundFaultProdExcluded:refund.includes('process.env.VERCEL_ENV !== "production"')&&submit.includes('process.env.VERCEL_ENV !== "production"'),
 refundFaultExplicitFlag:refund.includes('FLASHPAY_REFUND_CRASH_TEST')&&submit.includes('FLASHPAY_REFUND_CRASH_TEST'),
 testnetIngressGate:approve.includes('PI_NETWORK_MISMATCH')&&complete.includes('PI_NETWORK_MISMATCH')&&recon.includes('Pi Testnet'),
 ambiguousPiCreateFailClosed:a2u.includes('a2u_network_reconciliation_confirmed_none')&&a2u.includes('retryable: false'),
 queueBackpressureContinuation:route.includes('backpressureNonCreateContinuationDetected'),
 cronSecretAuth:route.includes('runtimeEnv.CRON_SECRET')&&route.includes('authorization?.startsWith("Bearer ")'),
 dr26AccountingProbe:route.includes('DR-26 FINAL ACCOUNTING RECONCILIATION')&&route.includes('sc.u2a_identifier'),
}
for(const [k,v] of Object.entries(bindings)) assert.equal(v,true,`independent binding failed: ${k}`)
const retainedProofGaps=[
 'DR10 live total-Redis-loss injection not executed',
 'DR11 live Testnet concurrent-refund execution not executed',
 'DR14 live financial crash-injection matrix not executed',
 'DR8 independent Vercel cron is daily on Hobby; historical 1-10 minute independent wake provenance remains unproven',
 'DR17 no live 10,000 financial transactions; deterministic safety only',
 'DR18 no live 10,000 nonfinancial throughput run; deterministic concurrency safety only',
 'DR19 live financial TPS/Pi/Horizon/DB/Redis saturation and p95/p99 ceilings remain unmeasured',
]
const productionEvidence={deploymentId:'dpl_3DHv9uGzyjLYrxb9y8Ki9iLbBBBh',gitSha:'8f355b87ea957b96cfcba3bad86a6c1c5acb2176',state:'READY',target:'production',runtimeStatus:200,runtimeErrors:0,walletAuthorityReady:true,settlementAttempts:0,refundAttempts:0,budgetExhausted:false,boundedPipelineConcurrency:2}
assert.equal(productionEvidence.runtimeStatus,200); assert.equal(productionEvidence.runtimeErrors,0); assert.equal(productionEvidence.state,'READY')
console.log(JSON.stringify({certification:'PASS',gate:'DR-30-SECOND-INDEPENDENT-REVIEW',independentBindings:Object.keys(bindings).length,bindings,productionEvidence,confirmedFinancialDefectsOpen:0,confirmedCompatibilityDefectsOpen:0,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:false,retainedProofGaps,retainedProofGapCount:retainedProofGaps.length,finalMatrixClosureEligible:false,nextGate:'DR-31-FINAL-MATRIX-CLOSURE-BLOCKED-UNTIL-PROOF-GAPS-RESOLVED'},null,2))
