import fs from 'node:fs'
import path from 'node:path'
const root=process.cwd()
const read=p=>fs.readFileSync(path.join(root,p),'utf8')
const assert=(c,m)=>{if(!c)throw new Error(`FIN4_STEP7_SCAFFOLD_HYGIENE=FAIL ${m}`)}
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[]
const prodFiles=[...walk(path.join(root,'app')),...walk(path.join(root,'lib'))].filter(p=>/\.(ts|tsx|js|mjs)$/.test(p))
const prod=prodFiles.map(p=>fs.readFileSync(p,'utf8')).join('\n')
assert(!fs.existsSync(path.join(root,'app/api/certification/fin4-trigger/route.ts')),'FIN4 trigger route remains')
assert(walk(path.join(root,'app/api/certification')).filter(p=>p.includes('/fin4-')).length===0,'FIN4 certification route remains')
assert(walk(path.join(root,'lib')).filter(p=>/\/fin4-[^/]+\.ts$/.test(p)).length===0,'FIN4 helper lib remains')
for(const marker of ['fin4-live-certification','FIN4_STAGE1_PREPARE','FLASHPAY_FIN4_ARMED','FLASHPAY_FIN4_RUN_ID','FLASHPAY_FIN4_PAYMENT_A','FLASHPAY_FIN4_PAYMENT_B']) assert(!prod.includes(marker),`production scaffold marker remains: ${marker}`)
const a2u=read('lib/a2u-executor.ts'), locked=read('lib/a2u-locked-executor.ts'), refund=read('lib/refund-auto-orchestrator.ts'), types=read('lib/types.ts'), db=read('lib/db.ts'), pi=read('lib/pi-sdk.ts')
for(const marker of ['acquirePiWalletIntentSubmitLock','recordSettlementPreparedCheckpoint','recordSettlementHorizonCheckpoint']) assert(a2u.includes(marker),`production wallet/finality binding lost: ${marker}`)
assert(a2u.includes('a2u_foreign_ongoing_payment'),'R4R foreign ongoing classification lost')
assert(types.includes('a2u_foreign_ongoing_payment'),'R4S fail-closed type guard lost')
for(const marker of ['readAutomaticRefundRetirementState','classifyAutomaticRefundRetirementBoundary']) assert(refund.includes(marker),`R4T4 refund retirement boundary lost: ${marker}`)
for(const marker of ['settlement_u2a_approval_retirements','settlement_a2u_stage1_retirements','settlement_a2u_ongoing_observations','refund_automatic_retirements']) assert(db.includes(marker),`durable retirement/audit primitive lost: ${marker}`)
assert(pi.includes('recover')||pi.includes('cancel'),'R4J Pi recovery support unexpectedly absent')
assert(!locked.includes('FIN4_STAGE1_PREPARE'),'certification-only Stage1 lane remains')
console.log('FIN4_STEP7_SCAFFOLD_REMOVAL_HYGIENE=PASS temporary_routes=0 temporary_libs=0 production_fixes=preserved wallet_lock=preserved')
