import fs from "node:fs"
const original=fs.readFileSync("lib/fin4-live-certification.ts","utf8")
const a=fs.readFileSync("lib/a2u-executor.ts","utf8")
const t=fs.readFileSync("app/api/certification/fin4-trigger/route.ts","utf8")
const validHarness=(s:string)=>[
  'process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1"',
  'paymentA === paymentB',
  'aProcess !== bProcess && aWallet === sourceWallet && bWallet === sourceWallet',
  'FIN4_FAIL_CLOSED_DISTINCT_PROCESS_BARRIER_TIMEOUT',
  'await redis.set(releasedKey, "1", { ex: 900 })',
  'if (await redis.get<string>(releasedKey) === "1")',
  'export async function fin4BestEffortEvent',
].every(x=>s.includes(x)) && !s.includes('submitTransaction(') && !s.includes('claimPiWalletIntent(')
const validIntegration=(s:string)=>s.includes('fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"')&&s.includes('fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASING")')&&s.includes('await walletLock.release()')&&s.includes('fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASED")')
const validTrigger=(s:string)=>s.includes('a.length === b.length && timingSafeEqual(a,b) ? expected : null')&&s.includes('fin4ArmedPaymentForRole(runId, body.role)')&&!s.includes('body.paymentId')&&s.includes('executeA2URecovery(paymentId)')&&!s.includes('submitTransaction(')
const hm:[string,string,string][]=[
 ['remove_production_gate','process.env.VERCEL_ENV !== "production" || ',''],
 ['allow_same_payment','paymentA === paymentB','false'],
 ['remove_distinct_process','aProcess !== bProcess && ',''],
 ['remove_same_wallet',' && aWallet === sourceWallet && bWallet === sourceWallet',''],
 ['remove_barrier_release_checkpoint','await redis.set(releasedKey, "1", { ex: 900 })',''],
 ['remove_reentry_progress','if (await redis.get<string>(releasedKey) === "1")','if (false)'],
 ['remove_best_effort_helper','export async function fin4BestEffortEvent','async function removedFin4BestEffortEvent'],
]
const im:[string,string,string][]=[
 ['post_movement_throwing_telemetry','fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"','fin4Event(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"'],
 ['pre_release_throwing_telemetry','fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASING"','fin4Event(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASING"'],
]
const tm:[string,string,string][]=[
 ['remove_trigger_auth','timingSafeEqual(a,b)','true'],
 ['allow_client_payment_id','fin4ArmedPaymentForRole(runId, body.role)','(body as any).paymentId'],
]
let expected=0
for(const [name,from,to] of hm){const m=original.split(from).join(to);if(m===original)throw new Error(`mutation not applied: ${name}`);if(validHarness(m))throw new Error(`unexpected mutation pass: ${name}`);expected++}
for(const [name,from,to] of im){const m=a.split(from).join(to);if(m===a)throw new Error(`mutation not applied: ${name}`);if(validIntegration(m))throw new Error(`unexpected mutation pass: ${name}`);expected++}
for(const [name,from,to] of tm){const m=t.split(from).join(to);if(m===t)throw new Error(`mutation not applied: ${name}`);if(validTrigger(m))throw new Error(`unexpected mutation pass: ${name}`);expected++}
if(!validHarness(original)||!validIntegration(a)||!validTrigger(t))throw new Error('original FIN4 R2 invalid')
console.log(`FIN4_LIVE_R2_MUTATIONS=PASS expected_failures=${expected} unexpected_passes=0`)
