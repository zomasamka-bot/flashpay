import fs from 'node:fs'
const p='lib/refund-presentation-persistence.ts'
const s=fs.readFileSync(p,'utf8')
const start=s.indexOf('function logRefundPresentationEvidenceMismatch')
const end=s.indexOf('\n}\n',start)+3
if(start<0||end<3) throw new Error('diagnostic helper missing')
const body=s.slice(start,end)
for(const token of ['paymentId:', 'refundId:', 'payerUid:', 'refundTxid:', 'refundPaymentId:', 'amount:', 'fee:', 'timestamp', 'idempotency']) if(body.includes(token)) throw new Error(`sensitive diagnostic field: ${token}`)
for(const token of ['UPDATE ', 'INSERT ', 'DELETE ', 'fetch(', 'redis.', 'query(']) if(body.includes(token)) throw new Error(`diagnostic mutates or performs IO: ${token}`)
const expected=['requestedTotal','requestedExact','confirmedTotal','confirmedExact','accountingEventTotal','accountingEventExact','accountingTotal','accountingExact','auditTotal','auditExact','completedTotal','completedExact','finalizedTotal','finalizedExact']
for(const token of expected) if(!body.includes(token)) throw new Error(`missing metric ${token}`)
if((s.match(/logRefundPresentationEvidenceMismatch\(/g)||[]).length!==3) throw new Error('expected helper definition + two call sites')
if(!s.includes('totalValue >= 0 && totalValue === exactValue')) throw new Error('fail-closed equality changed')
console.log(JSON.stringify({gate:'PRE-DR118-UX7-REFUND-PRESENTATION-DIAGNOSTIC',status:'PASS',readOnly:true,metrics:14,sensitiveFieldsLogged:0,decisionChanged:false},null,2))
