import fs from 'node:fs'
const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-diagnostic/route.ts','utf8')
for(const x of ["export async function GET","fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))","resolveFin4R4TSourceWallet","if(!resolved.ok)","readFin4R4TSubmitLockDiagnostic(resolved.sourceWallet)","lockAcquisitionExecuted:false","redisMutationExecuted:false","piMutationExecuted:false","horizonSubmitExecuted:false","financialAuthorityMutated:false"])if(!s.includes(x))throw new Error(`R4T5.1 missing invariant: ${x}`)
for(const x of ['acquirePiWalletSubmitLock','holdFin4R4TWalletProbe','contendFin4R4TWalletProbe','redis.set(','redis.del(','redis.eval(','executeA2U(','executeRefund'])if(s.includes(x))throw new Error(`R4T5.1 forbidden: ${x}`)
if(/export\s+async\s+function\s+POST\b/.test(s))throw new Error('R4T5.1 GET-only violated')
console.log('PASS verify-fin4-r4t51-read-only-lock-diagnostic-route')
