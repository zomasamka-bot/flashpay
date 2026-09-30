import fs from 'node:fs'
const p='lib/refund-presentation-persistence.ts'
const s=fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const must=(v,m)=>{if(!v)throw new Error(m)}
for(const x of ["a.details IS NULL","jsonb_typeof(a.details)='null'","jsonb_typeof(a.details)='string'","jsonb_typeof(a.details)='number'","jsonb_typeof(a.details)='boolean'","jsonb_typeof(a.details)='array'","jsonb_typeof(a.details)='object'","details_exact_serialized_canonical","details_exact_serialized_dr61"]) must(s.includes(x),`missing ${x}`)
must(!s.includes('SELECT a.details'),'raw details must not be selected')
must(!s.includes('details: diagnostic.'),'raw details must not be logged')
const diagnostic=s.slice(s.indexOf('const requestedDiagnostics = await query('),s.indexOf("console.warn('UX10_REFUND_REQUESTED_ROW_DIAGNOSTIC'",s.indexOf('const requestedDiagnostics = await query(')))
must(diagnostic.includes('`SELECT'),'diagnostic must be SELECT-only')
must(!/\b(INSERT|UPDATE|DELETE)\b/.test(diagnostic.replace(/intent_created/g,'')),'diagnostic must not mutate DB')
const matcher="a.idempotency_key LIKE 'dr11-live:%' AND a.details = jsonb_build_object('stage','intent_created','source','dr61_durable_hold')"
must(s.includes(matcher),'UX8 matcher changed')
console.log(JSON.stringify({pass:true,diagnosticOnly:true,safeTypeClassification:true,rawDetailsLogged:false,matcherUnchanged:true},null,2))
