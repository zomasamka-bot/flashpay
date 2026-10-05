import fs from 'node:fs'
const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-diagnostic/route.ts','utf8')
function valid(x){
  if(!x.includes("export async function GET")) return false
  if(!x.includes("fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))")) return false
  if(!x.includes("readFin4R4TSubmitLockDiagnostic(sourceWallet)")) return false
  for(const marker of ["lockAcquisitionExecuted: false","redisMutationExecuted: false","piMutationExecuted: false","horizonSubmitExecuted: false","financialAuthorityMutated: false"]) if(!x.includes(marker)) return false
  const forbidden=['acquirePiWalletSubmitLock','holdFin4R4TWalletProbe','contendFin4R4TWalletProbe','releaseFin4R4THolder','redis.set(','redis.del(','redis.eval(','executeA2U(','executeRefund']
  if(forbidden.some(k=>x.includes(k))) return false
  return !/export\s+async\s+function\s+POST\b/.test(x)
}
const muts=[
 ['drop authorization',s.replace("fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))","String(request.headers.get('x-flashpay-fin4-run-id'))")],
 ['replace diagnostic with holder',s.replace('readFin4R4TSubmitLockDiagnostic(sourceWallet)','holdFin4R4TWalletProbe(runId, sourceWallet)')+'\n// holdFin4R4TWalletProbe'],
 ['add acquisition primitive',s+'\n// acquirePiWalletSubmitLock'],
 ['add redis mutation',s+'\n// redis.set('],
 ['claim lock acquisition',s.replaceAll('lockAcquisitionExecuted: false','lockAcquisitionExecuted: true')],
 ['expose POST',s+'\nexport async function POST(){}'],
]
for(const [name,x] of muts) if(valid(x)) throw new Error(`SURVIVED mutation: ${name}`)
console.log(`PASS verify-fin4-r4t51-read-only-lock-diagnostic-route-mutations (${muts.length} killed)`)
