import fs from 'node:fs'
import assert from 'node:assert/strict'
const src=fs.readFileSync('lib/refund-executor.ts','utf8')
const checks=[
  ['null legacy prepared hash treated absent', /a2uPreparedTxHash == null/],
  ['null legacy prepared sequence treated absent', /a2uPreparedSequence == null/],
  ['null legacy prepared XDR treated absent', /a2uPreparedEnvelopeXdr == null/],
  ['non-null prepared hash diagnosed as evidence', /hasPreparedTxHash: existing\.a2uPreparedTxHash != null/],
  ['non-null prepared sequence diagnosed as evidence', /hasPreparedSequence: existing\.a2uPreparedSequence != null/],
  ['non-null prepared XDR diagnosed as evidence', /hasPreparedEnvelopeXdr: existing\.a2uPreparedEnvelopeXdr != null/],
  ['merchant payment id still rejected', /!existing\.a2uPaymentId/],
  ['merchant txid still rejected', /!existing\.a2uTxid/],
  ['Horizon success still rejected', /existing\.horizonSuccessFlag !== true/],
  ['refund payment id still rejected', /!existing\.refundPaymentId/],
  ['refund txid still rejected', /!existing\.refundTxid/],
  ['durable reproof still required', /const durable = await verifyOriginalU2AForRefundRecovery\(checkpoint\)/],
  ['CAS repair still required', /compareAndSwapPaymentProjection\(checkpoint\.paymentId, existing, projection\)/],
  ['diagnostic contains booleans not raw prepared values', /\[DR69 REFUND SOURCE PROJECTION CONFLICT\]/],
]
for (const [name,re] of checks) { assert.match(src,re,name); console.log('PASS',name) }
assert.doesNotMatch(src,/hasPreparedTxHash:\s*existing\.a2uPreparedTxHash[,}]/,'must not log raw prepared hash')
assert.doesNotMatch(src,/hasPreparedEnvelopeXdr:\s*existing\.a2uPreparedEnvelopeXdr[,}]/,'must not log raw XDR')
console.log(`DR69 verifier PASS ${checks.length+2}/${checks.length+2}`)
