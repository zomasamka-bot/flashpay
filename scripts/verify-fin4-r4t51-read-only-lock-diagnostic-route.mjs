import fs from 'node:fs'
const p='app/api/certification/fin4-r4t-lock-diagnostic/route.ts'
const s=fs.readFileSync(p,'utf8')
const must=[
  "export async function GET",
  "fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))",
  "readFin4R4TSubmitLockDiagnostic(sourceWallet)",
  "lockAcquisitionExecuted: false",
  "redisMutationExecuted: false",
  "piMutationExecuted: false",
  "horizonSubmitExecuted: false",
  "financialAuthorityMutated: false",
]
for(const x of must) if(!s.includes(x)) throw new Error(`R4T5.1 missing invariant: ${x}`)
const forbidden=[
  'acquirePiWalletSubmitLock','holdFin4R4TWalletProbe','contendFin4R4TWalletProbe',
  'releaseFin4R4THolder','redis.set(','redis.del(','redis.eval(','executeA2U','executeRefund',
]
for(const x of forbidden) if(s.includes(x)) throw new Error(`R4T5.1 forbidden mutation/acquisition surface: ${x}`)
if(/export\s+async\s+function\s+POST\b/.test(s)) throw new Error('R4T5.1 must not expose POST')
console.log('PASS verify-fin4-r4t51-read-only-lock-diagnostic-route')
