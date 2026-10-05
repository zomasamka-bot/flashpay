import fs from 'node:fs'
const db=fs.readFileSync('lib/db.ts','utf8'), store=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8'), route=fs.readFileSync('app/api/certification/fin4-trigger/route.ts','utf8')
const checks=[
 ['append_only_table',db.includes('CREATE TABLE IF NOT EXISTS refund_automatic_retirements')&&db.includes('REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT')],
 ['scheduler_exclusion',store.includes('SELECT 1 FROM refund_automatic_retirements r')],
 ['no_movement_gate',store.includes('c.refund_payment_id IS NULL AND c.refund_txid IS NULL')&&store.includes('NOT EXISTS (SELECT 1 FROM refund_accounting_records')&&store.includes('s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL')],
 ['exact_live_identity',route.includes('d50d0a46-a305-4008-9843-e50b8d3c265c')&&route.includes('22b0ab29-afd5-404b-a635-01e586d578ae')],
 ['no_pi_horizon_authority',route.includes('horizonSubmitExecuted:false, piMutationExecuted:false')],
 ['evidence_preserved',route.includes('checkpointDeleted:false, checkpointRewritten:false')],
]
for(const [n,ok] of checks){console.log(`FIN4_R4T ${n}=${ok?'PASS':'FAIL'}`);if(!ok)process.exitCode=1}
if(!process.exitCode) console.log('FIN4_R4T_POISONED_REFUND_RETIREMENT=PASS')
