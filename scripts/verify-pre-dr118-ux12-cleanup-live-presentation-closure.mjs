import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const reader=read('lib/refund-presentation-reader.ts')
const customer=read('lib/customer-refund-presentation-reader.ts')
const persistence=read('lib/refund-presentation-persistence.ts')
const profile=read('app/api/profile/route.ts')
const must=(v,m)=>{if(!v)throw new Error(m)}
for(const tag of ['UX9_REFUND_PRESENTATION_DIAGNOSTIC','UX9_CUSTOMER_REFUND_DIAGNOSTIC','UX10_REFUND_REQUESTED_ROW_DIAGNOSTIC']) {
  must(!reader.includes(tag) && !customer.includes(tag) && !persistence.includes(tag),`runtime diagnostic remains: ${tag}`)
}
const exact=`a.details = to_jsonb('{"stage":"intent_created","source":"dr61_durable_hold"}'::text)`
must(persistence.includes(exact),'UX11 exact serialized DR61 matcher changed')
must(persistence.includes("a.idempotency_key LIKE 'dr11-live:%'"),'DR11 namespace binding changed')
must(persistence.includes("a.payment_id=$2 AND a.idempotency_key=$3"),'identity binding changed')
must(persistence.includes("a.actor_type='system' AND a.event_id <> ''"),'actor/event binding changed')
must(persistence.includes("if (!refundPresentationEvidenceIsExact(record)) return { outcome: 'INDETERMINATE' }"),'fail-closed persistence changed')
must(reader.includes('if (checkpointResult.state === "uncertain") return { outcome: "INDETERMINATE" }'),'checkpoint fail-closed changed')
must(reader.includes('if (persistence.outcome !== "FOUND") return { outcome: "INDETERMINATE" }'),'persistence fail-closed changed')
must(customer.includes('if (result.outcome !== "FOUND") return { outcome: "INDETERMINATE" }'),'customer fail-closed changed')
must(profile.includes('const completedRefund ='),'completed refund persistence missing')
must(profile.includes('return completedRefund || typeof payment.piPaymentId !== "string" || !settledPaymentIds.has(payment.piPaymentId)'),'completed refund stale-settlement override changed')
must(profile.includes('marker === "dismissed"'),'explicit dismissal requirement missing')
console.log(JSON.stringify({pass:true,diagnosticsRemoved:true,ux11MatcherPreserved:true,failClosedPreserved:true,completedRefundPersists:true,explicitDismissalRequired:true},null,2))
