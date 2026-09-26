import fs from 'node:fs'
const cas=fs.readFileSync('lib/payment-projection-cas.ts','utf8')
const ex=fs.readFileSync('lib/refund-executor.ts','utf8')
const checks=[]
checks.push(['dedicated adoption CAS', cas.includes('adoptUnparseableLegacyPaymentProjection')])
checks.push(['same payment id fenced in lua', cas.includes("if current.id~=ARGV[1] then return -2 end")])
checks.push(['merchant ids blocked', cas.includes('has(current.a2uPaymentId) or has(current.a2uTxid)')])
checks.push(['prepared evidence blocked', cas.includes('has(current.a2uPreparedTxHash)') && cas.includes('has(current.a2uPreparedSequence)') && cas.includes('has(current.a2uPreparedEnvelopeXdr)')])
checks.push(['horizon success blocked', cas.includes('current.horizonSuccessFlag==true')])
checks.push(['settled merchant blocked', cas.includes("current.status=='settled_to_merchant'")])
checks.push(['refund ids blocked', cas.includes('has(current.refundPaymentId) or has(current.refundTxid)')])
checks.push(['refund terminal evidence blocked', cas.includes("current.refundStatus=='submitted'") && cas.includes("current.refundStatus=='completed'")])
checks.push(['version fenced', cas.includes('current.redisProjectionVersion') && cas.includes('version+1')])
checks.push(['raw existence distinguished', ex.includes('const rawExisting = await redis.get') && ex.includes('!existing && rawExisting !== null && rawExisting !== undefined')])
checks.push(['durable proof precedes adoption', ex.indexOf('const durable = await verifyOriginalU2AForRefundRecovery(checkpoint)') < ex.indexOf('adoptUnparseableLegacyPaymentProjection(checkpoint.paymentId, projection)')])
checks.push(['post adoption guarded reread', ex.includes('!guarded(checkpoint, adoptedReadBack)')])
checks.push(['safe diagnostic', ex.includes('[DR70 UNPARSEABLE LEGACY PROJECTION ADOPTED]') && ex.includes('financialEvidenceAccepted: false')])
for(const [n,ok] of checks){ console.log(`${ok?'PASS':'FAIL'} ${n}`); if(!ok) process.exitCode=1 }
console.log(`DR70 certifier ${checks.filter(([,ok])=>ok).length}/${checks.length}`)
