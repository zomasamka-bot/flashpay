import fs from 'node:fs'
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const persistence=fs.readFileSync('lib/refund-presentation-persistence.ts','utf8')
if(!store.includes("JSON.stringify({stage:'intent_created'})")) throw new Error('DR61 producer is not canonical')
if(store.includes("JSON.stringify({stage:'intent_created',source:'dr61_durable_hold'})")) throw new Error('legacy DR61 producer shape remains')
for(const token of ["details=jsonb_build_object('stage','intent_created','source','dr61_durable_hold')","SELECT count(*)=1","event_type='refund_requested'","SET details=jsonb_build_object('stage','intent_created')"]){if(!persistence.includes(token)) throw new Error(`missing repair invariant: ${token}`)}
console.log('PRE_DR118_UX5_REFUND_PRESENTATION_COMPAT PASS')
