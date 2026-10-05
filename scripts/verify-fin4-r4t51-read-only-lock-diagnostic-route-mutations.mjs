import fs from 'node:fs'
const p='app/api/certification/fin4-r4t-lock-diagnostic/route.ts'
const original=fs.readFileSync(p,'utf8')
const verifier=fs.readFileSync('scripts/verify-fin4-r4t51-read-only-lock-diagnostic-route.mjs','utf8')
function check(s){
  const must=[
    "export async function GET",
    "fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))",
    "readFin4R4TSubmitLockDiagnostic(sourceWallet)",
    "lockAcquisitionExecuted: false","redisMutationExecuted: false",
    "piMutationExecuted: false","horizonSubmitExecuted: false","financialAuthorityMutated: false",
  ]
  if(must.some(x=>!s.includes(x))) return false
  const forbidden=['acquirePiWalletSubmitLock','holdFin4R4TWalletProbe','contendFin4R4TWalletProbe','releaseFin4R4THolder','redis.set(','redis.del(','redis.eval(','executeA2U','executeRefund']
  if(forbidden.some(x=>s.includes(x))) return false
  if(/export\s+async\s+function\s+POST\b/.test(s)) return false
  return true
}
const muts=[
 ['drop authorization', original.replace("fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))","String(request.headers.get('x-flashpay-fin4-run-id'))")],
 ['replace diagnostic with holder', original.replace('readFin4R4TSubmitLockDiagnostic(sourceWallet)','holdFin4R4TWalletProbe(runId, sourceWallet)')+'\n// holdFin4R4TWalletProbe'],
 ['add acquisition primitive', original+'\n// acquirePiWalletSubmitLock'],
 ['add redis mutation', original+'\n// redis.set('],
 ['claim lock acquisition', original.replace('lockAcquisitionExecuted: false','lockAcquisitionExecuted: true')],
 ['expose POST', original+'\nexport async function POST(){}'],
]
for(const [name,s] of muts) if(check(s)) throw new Error(`SURVIVED mutation: ${name}`)
console.log(`PASS verify-fin4-r4t51-read-only-lock-diagnostic-route-mutations (${muts.length} killed)`)
