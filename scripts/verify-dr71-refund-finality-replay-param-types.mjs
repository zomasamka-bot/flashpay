import fs from 'node:fs'
const src=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const checks=[]
const marker="const replay = await query(`SELECT event_id FROM refund_audit_events WHERE refund_id=$2 AND event_type='refund_projection_finalized'"
const start=src.indexOf(marker)
const end=start < 0 ? -1 : src.indexOf('\n', start)
const replay=start < 0 ? '' : src.slice(start, end)
checks.push(['terminal projection replay query exists', start >= 0])
checks.push(['refundPaymentId explicitly text typed', replay.includes("'refundPaymentId',$5::text")])
checks.push(['refundTxid explicitly text typed', replay.includes("'refundTxid',$6::text")])
checks.push(['legacy untyped jsonb parameters absent', !replay.includes("'refundPaymentId',$5,'refundTxid',$6")])
checks.push(['query remains read-only replay verification', replay.includes('SELECT event_id FROM refund_audit_events') && !replay.includes('UPDATE ') && !replay.includes('INSERT ')])
checks.push(['exact terminal event remains required', replay.includes("event_type='refund_projection_finalized'") && replay.includes('event_id=$1')])
checks.push(['same identity fences retained', replay.includes('refund_id=$2') && replay.includes('payment_id=$3') && replay.includes('idempotency_key=$4')])
checks.push(['same exact JSON evidence retained', replay.includes("details=jsonb_build_object('refundPaymentId',$5::text,'refundTxid',$6::text)")])
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) process.exitCode=1}
console.log(`DR71 certifier ${checks.filter(([,ok])=>ok).length}/${checks.length}`)
