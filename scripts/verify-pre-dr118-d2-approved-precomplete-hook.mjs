import fs from 'node:fs'
const src=fs.readFileSync(new URL('../lib/pi-sdk.ts', import.meta.url),'utf8')
const must=[
  'Math.abs(amount - 0.11) < 1e-9',
  '[PRE-DR118 D-2] exact 0.11 Pi approved/pre-complete interruption armed',
  'onProcessing?.("paid_to_app")',
]
for (const x of must) if(!src.includes(x)) throw new Error(`missing D-2 anchor: ${x}`)
const hook=src.indexOf('Math.abs(amount - 0.11) < 1e-9')
const complete=src.indexOf('fetch(`${config.appUrl}/api/pi/complete`', hook)
if(hook<0 || complete<0 || hook>complete) throw new Error('D-2 hook is not before browser /complete')
const serverFiles=['app/api/pi/complete/route.ts','lib/a2u-locked-executor.ts','lib/a2u-recovery-service.ts','lib/db.ts','lib/refund-executor.ts']
for(const f of serverFiles) if(!fs.existsSync(new URL('../'+f, import.meta.url))) throw new Error('missing locked financial file '+f)
console.log(JSON.stringify({gate:'PRE-DR118-D2-APPROVED-PRECOMPLETE',pass:true,amount:0.11,boundary:'after Pi SDK completion callback / before browser POST /api/pi/complete',serverFinancialMutationAdded:false,blindRetryAdded:false},null,2))
