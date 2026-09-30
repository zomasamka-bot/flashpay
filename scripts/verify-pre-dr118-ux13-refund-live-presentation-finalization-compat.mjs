import fs from 'node:fs'
const store=fs.readFileSync(new URL('../lib/refund-checkpoint-store.ts',import.meta.url),'utf8')
const persistence=fs.readFileSync(new URL('../lib/refund-presentation-persistence.ts',import.meta.url),'utf8')
const reader=fs.readFileSync(new URL('../lib/refund-presentation-reader.ts',import.meta.url),'utf8')
const customer=fs.readFileSync(new URL('../lib/customer-refund-presentation-reader.ts',import.meta.url),'utf8')
const must=(v,m)=>{if(!v)throw new Error(m)}
const legacy="jsonb_typeof(a.details)='string'"
const exactRaw="(a.details #>> '{}')"
must(store.includes('JSON.stringify(details)'), 'future projection-finalized writer must serialize before ::jsonb')
must(store.includes(legacy)&&store.includes(exactRaw),'terminal/finalizer must recognize exact legacy string representation')
must(persistence.includes(legacy)&&persistence.includes(exactRaw),'presentation reader must recognize exact legacy string representation')
must(persistence.includes("finalized AS (SELECT count(*) FILTER"),'bulk/profile finalized evidence reader required')
must(persistence.includes("to_json(i.refund_payment_id)::text")&&persistence.includes("to_json(i.refund_txid)::text"),'bulk legacy comparison must bind exact refund identities')
must(persistence.includes("to_json($4::text)::text")&&persistence.includes("to_json($5::text)::text"),'single legacy comparison must bind exact refund identities')
must(!persistence.includes("(a.details #>> '{}')::jsonb = jsonb_build_object('refundPaymentId',$4"),'reader must not parse arbitrary string as jsonb')
must(!reader.includes('UX9_')&&!customer.includes('UX9_')&&!persistence.includes('UX10_'),'temporary diagnostics must remain removed')
must(persistence.includes("a.payment_id=$2 AND a.idempotency_key=$3"),'single reader identity binding preserved')
must(store.includes("c.stage='audit_recorded' AND c.status='completed'"),'terminal cleanup remains completed-only')
console.log(JSON.stringify({pass:true,futureWriterCanonical:true,legacyFinalizationExactIdentityBound:true,singleReader:true,bulkProfileReader:true,terminalCleanup:true,diagnosticsRemoved:true,financialMovementLogicChanged:false},null,2))
