import fs from 'node:fs'
const db=fs.readFileSync('lib/db.ts','utf8')
const migration=fs.readFileSync('migrations/R36_ACL_LEGACY_SCHEMA_REFERENCE_REVIEW_ONLY.sql','utf8')
const store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const old='s.horizon_confirmed=TRUE'
const canonical='s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL'
const checks=[
 ['schema_has_canonical_timestamp', /horizon_confirmed_at\s+TIMESTAMP/.test(migration)],
 ['schema_has_no_boolean_column', !/(^|\n)\s*horizon_confirmed\s+(BOOLEAN|BOOL)\b/im.test(migration)],
 ['durable_movement_contract', migration.includes('a2u_txid IS NOT NULL') && migration.includes('horizon_confirmed_at IS NOT NULL') && migration.includes("stage NOT IN ('horizon_confirmed','pi_completed','db_finalized')")],
 ['retirement_uses_canonical_evidence', store.includes(canonical)],
 ['phantom_boolean_removed', !store.includes(old)],
 ['refund_and_accounting_barriers_preserved', store.includes('c.refund_payment_id IS NULL AND c.refund_txid IS NULL') && store.includes('NOT EXISTS (SELECT 1 FROM refund_accounting_records')],
]
for(const [n,ok] of checks){console.log(`FIN4_R4T2 ${n}=${ok?'PASS':'FAIL'}`);if(!ok)process.exitCode=1}
if(!process.exitCode) console.log('FIN4_R4T2_CANONICAL_HORIZON_EVIDENCE=PASS')
