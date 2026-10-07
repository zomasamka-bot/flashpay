import fs from 'node:fs'
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8')
const db=read('lib/db.ts'), store=read('lib/refund-checkpoint-store.ts'), exec=read('lib/refund-executor.ts')
const must=(ok,msg)=>{if(!ok)throw new Error(`FIN7 refund-create verifier failed: ${msg}`)}
must(db.includes('CREATE TABLE IF NOT EXISTS refund_pi_create_attempts'),'durable create-attempt table missing')
must(db.includes('refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT'),'refund identity uniqueness/FK missing')
must(db.includes('payment_id TEXT NOT NULL UNIQUE')&&db.includes('idempotency_key TEXT NOT NULL UNIQUE'),'payment/idempotency uniqueness missing')
must(store.includes('export async function claimRefundCreateAttempt'),'create claim missing')
must(store.includes("r.pi_mutation_guard_version!=='fin7_v2'")&&store.includes("r.stage!=='wallet_submission_started'")&&store.includes('r.refund_payment_id!=null||r.refund_txid!=null'),'exact guarded lifecycle missing')
must(store.includes('INSERT INTO refund_pi_create_attempts(refund_id,payment_id,idempotency_key)')&&store.includes('ON CONFLICT DO NOTHING RETURNING attempted_at'),'append-only claim missing')
const claim=exec.indexOf('const createAttempt = await claimRefundCreateAttempt(')
const gate=exec.indexOf("createAttempt.outcome !== 'RECORDED'",claim)
const post=exec.indexOf("fetch('https://api.minepi.com/v2/payments'",claim)
must(claim>=0&&gate>claim&&post>gate,'RECORDED-only claim must precede Refund create POST')
const createPosts=(exec.match(/fetch\('https:\/\/api\.minepi\.com\/v2\/payments'/g)||[]).length
must(createPosts===1,`expected exactly one Refund create POST surface, found ${createPosts}`)
must(exec.includes("checkpoint.stage === 'wallet_submission_started' && (checkpoint.refundPaymentId || checkpoint.refundTxid)"),'existing identity uncertainty gate missing')
must(exec.includes("if (reconciliation.outcome === 'INDETERMINATE') return { outcome: 'blocked'"),'reconcile-first uncertainty gate missing')
console.log('FIN7_REFUND_CREATE_ONE_SHOT_AUTHORITY=PASS guard=fin7_v2 legacy=fail_closed post=recorded_only crash_after_claim=no_retry')
