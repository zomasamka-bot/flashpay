import fs from 'node:fs'
const s=fs.readFileSync(new URL('../lib/refund-presentation-persistence.ts',import.meta.url),'utf8')
const must=(v,m)=>{if(!v)throw new Error(m)}
const exact=`a.details = to_jsonb('{"stage":"intent_created","source":"dr61_durable_hold"}'::text)`
must(s.includes(exact),'missing exact serialized DR61 compatibility')
must(s.includes("a.idempotency_key LIKE 'dr11-live:%'"),'legacy compatibility must remain DR11 namespace-bound')
must(s.includes("a.payment_id=$2 AND a.idempotency_key=$3"),'identity predicates must remain exact')
must(s.includes("a.actor_type='system' AND a.event_id <> ''"),'actor/event predicates must remain exact')
must(!s.includes("jsonb_typeof(a.details)='string'"),'must not broadly accept arbitrary strings')
must(!s.includes('UX9_REFUND_PRESENTATION_DIAGNOSTIC'),'UX9 runtime diagnostic must be removed')
must(!s.includes('UX10_REFUND_REQUESTED_ROW_DIAGNOSTIC'),'UX10/10B/10C runtime diagnostic must be removed')
must(s.includes("if (!refundPresentationEvidenceIsExact(record)) return { outcome: 'INDETERMINATE' }"),'fail-closed mismatch behavior required')
must(!/\bUPDATE\s+refund_audit_events\b/i.test(s),'must not rewrite historical audit evidence')
console.log(JSON.stringify({pass:true,exactSerializedDr61Only:true,namespaceBound:true,identityBound:true,arbitraryStringsRejected:true,diagnosticsRemoved:true,failClosed:true,historicalRowsUnmodified:true},null,2))
