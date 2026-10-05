import fs from'node:fs'
const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-cross-instance/route.ts','utf8')
for(const x of[
 "const CONTENDER_COUNT=8",
 "resolveFin4R4TSourceWallet()",
 "const origin=request.nextUrl.origin",
 "fetch(`${origin}${path}`",
 "cache:'no-store'",
 "postProbe(origin,'/api/certification/fin4-r4t-lock-holder',runId)",
 "Promise.all(Array.from({length:CONTENDER_COUNT},()=>",
 "postProbe(origin,'/api/certification/fin4-r4t-lock-contender',runId)",
 "c.processId!==holder.processId",
 "c.acquired===false",
 "c.lockDiagnostic?.state==='busy'",
 "const exactWallet=(x:ProbeResult)=>x.sourceWallet===resolved.sourceWallet",
 "c.financialMovementExecuted===false",
 "distinctBlocked.length>0",
 "financialMovementExecuted:false",
 "piMutationExecuted:false",
 "horizonSubmitExecuted:false",
 "financialAuthorityMutated:false"
])if(!s.includes(x))throw Error(`R4T5.4 missing ${x}`)
for(const x of["holdFin4R4TWalletProbe","contendFin4R4TWalletProbe","acquirePiWalletSubmitLock","executeA2U","executeRefund","FLASHPAY_PI_PUBLIC_KEY"])if(s.includes(x))throw Error(`R4T5.4 forbidden ${x}`)
console.log('PASS verify-fin4-r4t54-cross-instance-orchestrator')
