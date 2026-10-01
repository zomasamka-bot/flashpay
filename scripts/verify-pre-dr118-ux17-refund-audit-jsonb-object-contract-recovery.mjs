import fs from 'node:fs'
const p='lib/refund-checkpoint-store.ts'
const s=fs.readFileSync(p,'utf8')
const fail=(m)=>{console.error('UX17 FAIL:',m);process.exit(1)}
const stringify=[...s.matchAll(/JSON\.stringify\((?:event\.details|details|\{stage:'intent_created'\})\)/g)]
if(stringify.length!==0) fail(`refund audit JSON stringify sites remain: ${stringify.length}`)
const required=[
  "event.eventType, event.actorType, event.createdAt, event.details",
  "event.eventType, event.actorType, event.createdAt, event.details, idempotencyKey",
  "const params = [refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, event.eventId, event.eventType, event.actorType, event.createdAt, event.details]",
  "event.actorType, event.createdAt, event.details]",
  "event.idempotencyKey, event.createdAt, event.details]",
]
for(const x of required) if(!s.includes(x)) fail(`missing object binding evidence: ${x}`)
if(!s.includes("jsonb_typeof(details)='string'")) fail('legacy string repair guard missing')
if(!s.includes("count(*)=3")||!s.includes("event_type='refund_submission_confirmed'")||!s.includes("event_type='refund_payment_checkpoint_updated'")||!s.includes("event_type='refund_accounting_recorded'")) fail('three-event exact repair cardinality missing')
if(!s.includes("actor_type='system' AND event_id<>''")) fail('repair identity guard missing')
if(!s.includes("SET details=(c.details #>> '{}')::jsonb")) fail('legacy exact JSON string to object conversion missing')
if(!s.includes('RETURNING a.event_type')) fail('repair mutation cardinality proof missing')
if(!s.includes('Array.isArray(repaired) && repaired.length === 3')) fail('repair exact-count gate missing')
if(!s.includes('return advanceRefundAuditWithAudit(refundId, paymentId, idempotencyKey, refundPaymentId, refundTxid, payerUid, amount, horizonFeeStroops, event)')) fail('post-repair audit-only retry missing')
if(s.includes('server.submitTransaction')||s.includes('POST /v2/payments')) fail('wallet submission logic unexpectedly added to store patch')
console.log(JSON.stringify({ux17:'PASS',jsonStringifyAuditSites:0,objectBindingContract:true,legacyRepairExactThree:true,repairIdentityBound:true,auditOnlyRetry:true,financialResubmitAdded:false},null,2))
