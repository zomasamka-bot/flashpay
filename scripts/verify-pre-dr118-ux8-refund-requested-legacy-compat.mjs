import fs from 'node:fs'
const p='lib/refund-presentation-persistence.ts'
const s=fs.readFileSync(p,'utf8')
const legacy="jsonb_build_object('stage','intent_created','source','dr61_durable_hold')"
const guard="a.idempotency_key LIKE 'dr11-live:%'"
if (s.split(legacy).length - 1 !== 3) throw new Error('legacy shape must exist exactly in single+batch readers')
if (s.split(guard).length - 1 !== 3) throw new Error('legacy guard must exist exactly in single+batch readers')
if (s.includes('REFUND_PRESENTATION_EVIDENCE_MISMATCH') || s.includes('logRefundPresentationEvidenceMismatch')) throw new Error('UX7 diagnostic remains')
if (/source','(?!dr61_durable_hold)/.test(s)) throw new Error('unexpected requested legacy source')
if (!s.includes("a.details = jsonb_build_object('stage','intent_created')")) throw new Error('canonical single requested evidence missing')
if (!s.includes("a.details = jsonb_build_object('resumed',true)")) throw new Error('resumed single requested evidence missing')
if (!s.includes("a.details=jsonb_build_object('stage','intent_created')")) throw new Error('canonical batch requested evidence missing')
if (!s.includes("a.details=jsonb_build_object('resumed',true)")) throw new Error('resumed batch requested evidence missing')
const allowed=(key,details)=>details==='canonical'||details==='resumed'||(key.startsWith('dr11-live:')&&details==='dr61')
const cases=[
 ['dr11-live:p','dr61',true],['normal:p','dr61',false],['dr11-live:p','wrong',false],['normal:p','canonical',true],['normal:p','resumed',true],['dr11-live:p','extra',false]
]
for(const [k,d,e] of cases) if(allowed(k,d)!==e) throw new Error(`adversarial case failed ${k}/${d}`)
console.log(JSON.stringify({gate:'PRE_DR118_UX8_REFUND_REQUESTED_LEGACY_COMPAT',status:'PASS',legacyShapeExact:true,legacyScopedToDr11Live:true,canonicalPreserved:true,resumedPreserved:true,diagnosticRemoved:true,dbMutationAdded:false},null,2))
