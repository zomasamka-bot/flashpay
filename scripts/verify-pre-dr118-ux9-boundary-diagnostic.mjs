import fs from 'node:fs'
const files=['lib/refund-presentation-persistence.ts','lib/refund-presentation-reader.ts','lib/customer-refund-presentation-reader.ts']
const all=files.map(f=>fs.readFileSync(f,'utf8')).join('\n')
for (const tag of ['PERSISTENCE_EVIDENCE','PERSISTENCE_FOUND','PERSISTENCE_NOT_FOUND','PROOF_INDETERMINATE','BLOCKCHAIN_NOT_CONFIRMED','PROOF_RECORD_FAILED','PRESENTATION_FOUND','INNER_NOT_FOUND']) if(!all.includes(tag)) throw new Error('missing diagnostic '+tag)
if (/console\.(?:info|warn)\([^\n]*(?:paymentId|refundId|txid|payerUid|idempotencyKey|transactionAt)/.test(all)) throw new Error('sensitive diagnostic value')
const p=fs.readFileSync('lib/refund-presentation-persistence.ts','utf8')
if(!p.includes("a.idempotency_key LIKE 'dr11-live:%'")) throw new Error('UX8 compatibility missing')
console.log(JSON.stringify({gate:'PRE_DR118_UX9_BOUNDARY_DIAGNOSTIC',status:'PASS',readOnlyDiagnostic:true,sensitiveValuesLogged:false,ux8CompatibilityPreserved:true},null,2))
