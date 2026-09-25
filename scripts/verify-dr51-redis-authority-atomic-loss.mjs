import fs from 'node:fs'
const read=p=>fs.readFileSync(p,'utf8')
const recovery=read('app/api/recovery/transient/route.ts')
const payments=read('app/api/payments/route.ts')
const db=read('lib/db.ts')
const refunds=read('lib/refund-checkpoint-store.ts')
const wallet=read('lib/pi-wallet-submit-lock.ts')
const roots=['app','lib']
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${d}/${e.name}`):[/\.(ts|tsx|js|mjs)$/.test(e.name)?`${d}/${e.name}`:null].filter(Boolean))
const files=roots.flatMap(walk).filter(p=>p!=='app/api/recovery/transient/route.ts')
const legacyPatterns=[/`a2u:/,/`transaction:/,/`receipt:/,/`merchant:\$\{[^}]+\}:transactions/,/`merchant:\$\{[^}]+\}:balance/,/txn-counter/]
const legacyConsumers=[]
for(const p of files){const s=read(p);if(legacyPatterns.some(r=>r.test(s)))legacyConsumers.push(p)}
const result={
 dr51: legacyConsumers.length===0?'PASS':'FAIL',
 consumerGraph:{legacyRedisConsumers:legacyConsumers,currentTransactionAuthority:/getTransactionsByMerchant/.test(read('app/api/transactions/route.ts'))?'postgres':'unknown',currentReceiptUsesCanonicalProjection:/`payment:\$\{flashPayPaymentId\}`/.test(read('app/api/receipts/[id]/route.ts'))},
 authorityClassification:{legacyNamespacesOperationalAuthority:false,paymentProjectionRedisOperational:true,settlementAuthorityPostgres:/getSettlementCheckpointAuthoritative/.test(recovery),refundAuthorityPostgres:/SELECT \* FROM refund_checkpoints/.test(refunds)},
 reconstructability:{u2aIngressDurableRotation:/listRecoverableU2AIngressCheckpointIds/.test(db),settlementDurableRotation:/listOutstandingSettlementCheckpointIds/.test(db),refundCheckpointDurable:/getRefundCheckpointAuthoritative/.test(refunds),redisLossIndependentCursors:/cursor is durable and independent of Redis/.test(db)},
 liveLossRequiredState:{newPaymentGate:/DR10_CERTIFICATION_MAINTENANCE/.test(payments),walletSubmitLockPresent:/flashpay:wallet:submit:/.test(wallet),atomicScriptBlocksWalletSubmit:/activeWalletSubmit > 0/.test(recovery),atomicScriptBlocksDrain:/activeDrain > 0/.test(recovery)},
 atomicity:{usesEval:/DR51_ATOMIC_TOTAL_LOSS_SCRIPT/.test(recovery),usesFlushDbInsideScript:/redis\.call\('FLUSHDB'\)/.test(recovery),ownershipRecheckedInsideAtomicScript:/unknown > 0/.test(recovery),bounded100k:/size > 100000/.test(recovery),oldBatchDeleteRemoved:!recovery.includes('DR10 Redis deletion failed'),successResponseUsesAtomicResult:recovery.includes('preflightKeys:atomicPreflightKeys,deleted:atomicPreflightKeys,atomicGlobalLock:true')},
 safety:{censusStillNondestructive:recovery.indexOf('if(censusOnly) {') < recovery.indexOf('DR51_ATOMIC_TOTAL_LOSS_SCRIPT'),atomicScriptNoExternalFetch:!recovery.slice(recovery.indexOf('const DR51_ATOMIC_TOTAL_LOSS_SCRIPT'),recovery.indexOf('let atomicLoss')).includes('fetch('),atomicScriptNoHorizon:!recovery.slice(recovery.indexOf('const DR51_ATOMIC_TOTAL_LOSS_SCRIPT'),recovery.indexOf('let atomicLoss')).includes('Horizon')}
}
if(Object.values(result.reconstructability).some(v=>!v)||Object.values(result.liveLossRequiredState).some(v=>!v)||Object.values(result.atomicity).some(v=>!v)||Object.values(result.safety).some(v=>!v)||result.dr51!=='PASS')result.dr51='FAIL'
console.log(JSON.stringify(result,null,2))
if(result.dr51!=='PASS')process.exit(1)
