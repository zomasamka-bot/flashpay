import fs from 'node:fs'
const p='lib/refund-presentation-persistence.ts'
const s=fs.readFileSync(p,'utf8')
if(s.includes('jsonb_object_length')) throw new Error('jsonb_object_length remains')
const replacement='(SELECT count(*) FROM jsonb_object_keys(a.details))'
if((s.split(replacement).length-1)!==2) throw new Error('expected exactly two scalar jsonb_object_keys counts')
if(!s.includes("record.requested_total > record.requested_exact")) throw new Error('diagnostic is not mismatch-scoped')
const marker=s.indexOf('const requestedDiagnostics = await query(')
if(marker<0) throw new Error('diagnostic query missing')
const end=s.indexOf('[checkpoint.refundId, checkpoint.paymentId, checkpoint.idempotencyKey]',marker)
if(end<0) throw new Error('diagnostic query parameters missing')
const q=s.slice(marker,end)
if(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(q)) throw new Error('diagnostic query is not SELECT-only')
if(!q.includes('jsonb_object_keys(a.details)')) throw new Error('replacement not in diagnostic query')
const matcher="a.idempotency_key LIKE 'dr11-live:%' AND a.details = jsonb_build_object('stage','intent_created','source','dr61_durable_hold')"
if(!s.includes(matcher)) throw new Error('UX8 matcher changed')
const log=s.slice(s.indexOf("console.warn('UX10_REFUND_REQUESTED_ROW_DIAGNOSTIC'",marker),s.indexOf('} catch {',marker))
for(const sensitive of ['checkpoint.refundId','checkpoint.paymentId','checkpoint.idempotencyKey','refundPaymentId','refundTxid','payerUid','amount','transactionAt']) if(log.includes(sensitive)) throw new Error('sensitive diagnostic log '+sensitive)
console.log(JSON.stringify({gate:'PRE_DR118_UX10B_REFUND_REQUESTED_ROW_DIAGNOSTIC_SQL',status:'PASS',jsonbObjectLength:0,jsonbObjectKeysScalarCounts:2,selectOnly:true,mismatchScoped:true,matcherUnchanged:true,sensitiveLogging:false},null,2))
