import fs from'node:fs';const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-cross-instance/route.ts','utf8')
function ok(x){const req=["const CONTENDER_COUNT=8","fetch(`${origin}${path}`","cache:'no-store'","postProbe(origin,'/api/certification/fin4-r4t-lock-holder',runId)","Promise.all(Array.from({length:CONTENDER_COUNT},()=>","postProbe(origin,'/api/certification/fin4-r4t-lock-contender',runId)","c.processId!==holder.processId","c.acquired===false","c.lockDiagnostic?.state==='busy'","const exactWallet=(x:ProbeResult)=>x.sourceWallet===resolved.sourceWallet","c.financialMovementExecuted===false","distinctBlocked.length>0","financialMovementExecuted:false","piMutationExecuted:false","horizonSubmitExecuted:false","financialAuthorityMutated:false"];return req.every(k=>x.includes(k))&&!["holdFin4R4TWalletProbe","contendFin4R4TWalletProbe","acquirePiWalletSubmitLock","executeA2U","executeRefund","FLASHPAY_PI_PUBLIC_KEY"].some(k=>x.includes(k))}
const muts=[
 s.replaceAll("c.processId!==holder.processId","true"),
 s.replaceAll("c.acquired===false","true"),
 s.replaceAll("c.lockDiagnostic?.state==='busy'","true"),
 s.replace("const exactWallet=(x:ProbeResult)=>x.sourceWallet===resolved.sourceWallet","const exactWallet=(_x:ProbeResult)=>true"),
 s.replaceAll("c.financialMovementExecuted===false","true"),
 s.replaceAll("distinctBlocked.length>0","true"),
 s.replace("Promise.all(Array.from({length:CONTENDER_COUNT},()=>","Array.from({length:CONTENDER_COUNT},()=>"),
 s+"// acquirePiWalletSubmitLock"
]
for(const x of muts)if(ok(x))throw Error('SURVIVED')
console.log(`PASS verify-fin4-r4t54-cross-instance-orchestrator-mutations (${muts.length} killed)`)
