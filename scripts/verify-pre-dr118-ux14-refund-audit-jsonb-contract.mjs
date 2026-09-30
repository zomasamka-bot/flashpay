import fs from 'node:fs'
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const presentation=fs.readFileSync('lib/refund-presentation-persistence.ts','utf8')
const must=(v,m)=>{if(!v)throw new Error(m)}
const direct=[...store.matchAll(/event\.createdAt,\s*event\.details/g)]
must(direct.length===0,'raw event.details must never be passed as a postgres ::jsonb parameter')
const canonical=[...store.matchAll(/JSON\.stringify\(event\.details\)/g)].length
must(canonical>=9,`expected canonical audit writers, got ${canonical}`)
for(const ev of ['refund_submission_confirmed','refund_accounting_recorded','refund_audit_recorded','refund_completed','refund_projection_finalized']) must(store.includes(ev),`missing ${ev}`)
must(store.includes("event.eventType !== 'refund_completed'"),'completion semantic guard retained')
must(store.includes("event.eventType !== 'refund_submission_confirmed'"),'submission semantic guard retained')
must(presentation.includes("a.details = jsonb_build_object('stage','intent_created')"),'canonical requested object reader retained')
must(presentation.includes("to_jsonb('{\"stage\":\"intent_created\",\"source\":\"dr61_durable_hold\"}'::text)"),'proven DR61 legacy compatibility retained')
must(presentation.includes("jsonb_typeof(a.details)='string'"),'bounded legacy finalized compatibility retained')
must(!presentation.includes("(a.details #>> '{}')::jsonb"),'must not parse arbitrary JSONB strings into objects')
console.log(JSON.stringify({gate:'PRE-DR118-UX14-REFUND-AUDIT-JSONB-CONTRACT',status:'PASS',canonicalWriterSites:canonical,rawObjectParameterSites:direct.length,financialMovementExecuted:false},null,2))
