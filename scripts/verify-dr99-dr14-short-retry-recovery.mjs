import fs from 'node:fs'
const auto = fs.readFileSync('lib/refund-auto-orchestrator.ts','utf8')
const store = fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
const exec = fs.readFileSync('lib/refund-executor.ts','utf8')
const checks = [
 ['DR14 interruption is short retry', /SHORT_RETRY_REASONS[\s\S]*["']dr14_interruption["']/.test(auto)],
 ['DR14 existing deferral compatibility is exact error code', store.includes("last_error_code='automatic_refund_blocked'")],
 ['DR14 existing deferral compatibility is exact reason', store.includes("last_error_message='dr14_interruption'")],
 ['DR14 compatibility waits at least 60 seconds', store.includes("updated_at<=NOW()-INTERVAL '60 seconds'")],
 ['normal retry authority remains present', store.includes('next_retry_at<=NOW()')],
 ['boundary 1 still interrupts after verified create and before following id persistence', /verified reconciliation:[\s\S]{0,1800}consumeDr14Crash\(checkpoint\.paymentId, 'refund_after_pi_create_before_id_checkpoint'\)[\s\S]{0,600}persistRefundPaymentIdWithAudit/.test(exec)],
]
let fail=0
for (const [n,ok] of checks) { console.log(`${ok?'PASS':'FAIL'} ${n}`); if(!ok) fail++ }
if(fail) process.exit(1)
console.log('DR99 DR14 SHORT RETRY RECOVERY: PASS')
