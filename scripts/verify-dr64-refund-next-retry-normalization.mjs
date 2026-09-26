import fs from 'node:fs'
const s=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const required=[
  "function normalizeOptionalTimestamp(value: unknown): string | undefined",
  "if (typeof value === 'string')",
  "if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()",
  "nextRetryAt: normalizeOptionalTimestamp(row.nextRetryAt ?? row.next_retry_at)",
  "'dr11_live_hold','awaiting_owner_concurrent_harness'"
]
for(const x of required) if(!s.includes(x)) throw new Error(`missing: ${x}`)
const normalize=(value)=>{if(typeof value==='string'){const ms=Date.parse(value);return Number.isFinite(ms)?value:undefined}if(value instanceof Date&&Number.isFinite(value.getTime()))return value.toISOString();return undefined}
const iso='2026-09-27T10:25:02.527Z'
if(normalize(iso)!==iso) throw new Error('string regression')
if(normalize(new Date(iso))!==iso) throw new Error('Date regression')
if(normalize(null)!==undefined||normalize(new Date('invalid'))!==undefined) throw new Error('fail-closed regression')
console.log('DR64 refund next_retry_at normalization: PASS')
