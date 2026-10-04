import fs from "node:fs"
import path from "node:path"
const root = process.cwd()
const dashboard = fs.readFileSync(path.join(root,"app/merchant/payments/page.tsx"),"utf8")
const complete = fs.readFileSync(path.join(root,"app/api/pi/complete/route.ts"),"utf8")
const recovery = fs.readFileSync(path.join(root,"app/api/recovery/transient/route.ts"),"utf8")
const refund = fs.readFileSync(path.join(root,"lib/refund-auto-orchestrator.ts"),"utf8")
const vercel = JSON.parse(fs.readFileSync(path.join(root,"vercel.json"),"utf8")) as { crons?: Array<{ path?: unknown; schedule?: unknown }> }
function need(ok:boolean,msg:string){if(!ok) throw new Error(msg)}
// P2: presentation refresh only, no financial endpoint/write introduced.
need(dashboard.includes('window.setInterval(refreshWhileVisible, 20_000)'),"P2 bounded dashboard refresh missing")
need(dashboard.includes('void fetchPayments(true)'),"P2 silent background refresh missing")
need(dashboard.includes('if (!background) {'),"P2 background refresh must not blank dashboard")
need(dashboard.includes('document.addEventListener("visibilitychange", refreshWhileVisible)'),"P2 visibility refresh missing")
need(dashboard.includes('/api/merchant/payments?'),"P2 canonical merchant read endpoint missing")
need(!dashboard.includes('/api/recovery/transient'),"P2 dashboard must not invoke recovery")
// P3: prove liveness architecture; daily cron is only an independent safety net.
need(complete.includes('IMMEDIATE_DRAIN_KICK_TTL_SECONDS = 90'),"P3 immediate kick coalescing missing")
need(complete.includes('immediateDrainRequestUrl.searchParams.set("mode", IMMEDIATE_DRAIN_MODE)'),"P3 completion immediate drain binding missing")
need(recovery.includes('scheduleTrustedTransientRequest("continuation-kick")'),"P3 continuation binding missing")
need(recovery.includes('x-flashpay-transient-recovery-secret'),"P3 trusted external scheduler authority missing")
need(refund.includes('return 60_000'),"P3 one-minute short refund retry missing")
need(Array.isArray(vercel.crons) && vercel.crons.some((cron) => cron?.path === "/api/recovery/transient" && cron?.schedule === "0 21 * * *"),"P3 independent daily cron safety net changed unexpectedly")
// P4: exact certification hook and durable ordering remain intentional and unchanged.
need(complete.includes('INTENTIONAL LIVE TESTNET CERTIFICATION HOOK — DO NOT REMOVE AS BUSINESS CLEANUP.'),"P4 intent documentation missing")
need(complete.includes('process.env.VERCEL_ENV === "production" && finalPiPayment.network === "Pi Testnet" && finalPiPayment.amount === 0.1'),"P4 exact 0.10 production Testnet scope missing")
const hold=complete.indexOf('await recordDr11RefundCertificationHold({')
const completed=complete.indexOf('await recordSettlementU2ACompletedCheckpoint({')
const authority=complete.indexOf('await createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)')
need(hold>=0&&completed>=0&&authority>=0&&hold<completed&&completed<authority,"P4 DR11 durable ordering changed")
console.log('PLAN_I_P2_P4_REVIEW_CLOSURE=PASS dashboard_refresh=20s+visibility recovery=immediate+continuation short_refund_retry=60s daily_cron=safety_net dr11_0_10=intentional')
