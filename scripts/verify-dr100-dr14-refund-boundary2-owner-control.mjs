import fs from 'node:fs'
function read(p){return fs.readFileSync(p,'utf8')}
function must(c,m){if(!c){console.error('FAIL',m);process.exit(1)}}
const ui=read('app/control-panel/page.tsx')
const api=read('app/api/control/dr14/route.ts')
const exec=read('lib/refund-executor.ts')
const submit=read('lib/refund-blockchain-submit.ts')
const dr14=read('lib/dr14-live-crash-certification.ts')
const orch=read('lib/refund-auto-orchestrator.ts')
const store=read('lib/refund-checkpoint-store.ts')
const b='refund_after_prepared_before_submit'
must(ui.includes(`const dr14Boundary = "${b}" as const`),'UI must target boundary 2')
must(ui.includes('Boundary 2') && !ui.includes('Arm DR14 Boundary 1 — One Shot'),'visible control must identify boundary 2')
must(api.includes("stage='intent_created'") && api.includes("last_error_code='dr11_live_hold'") && api.includes("last_error_message='awaiting_owner_concurrent_harness'"),'START must release only pristine DR11 hold')
must(api.includes('executeRefundNextStep(refundId,{paymentId,refundId})'),'START must use normal refund executor')
must(dr14.includes(`'${b}'`),'boundary 2 must be in canonical DR14 matrix')
const prep=submit.indexOf('ensureRefundPreparedSubmit(')
const crash=submit.indexOf(`consumeDr14Crash(input.checkpoint.paymentId, '${b}')`)
const auth=submit.indexOf('authorizeRefundBlockchainSubmit(', crash)
const horizon=submit.indexOf('server.submitTransaction(transaction)', crash)
must(prep>=0 && crash>prep && auth>crash && horizon>auth,'crash must be after durable prepared checkpoint and before authorization/Horizon submit')
must(exec.includes("refund_after_horizon_submit_before_tx_checkpoint"),'next boundary hook must remain intact')
must(orch.includes("'dr14_interruption'") || store.includes("dr14_interruption"),'DR99 short-retry compatibility must remain present')
console.log('DR100 DR14 REFUND BOUNDARY 2 OWNER CONTROL: PASS')
