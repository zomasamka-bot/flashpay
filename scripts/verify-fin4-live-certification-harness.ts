import fs from "node:fs"
const need=(v:unknown,m:string)=>{if(!v)throw new Error(m)}
const h=fs.readFileSync("lib/fin4-live-certification.ts","utf8")
const a=fs.readFileSync("lib/a2u-executor.ts","utf8")
const l=fs.readFileSync("lib/a2u-locked-executor.ts","utf8")
const c=fs.readFileSync("app/api/pi/complete/route.ts","utf8")
const o=fs.readFileSync("app/api/certification/fin4-trigger/route.ts","utf8")
const ra=fs.readFileSync("app/api/certification/fin4-trigger-a/route.ts","utf8")
const rb=fs.readFileSync("app/api/certification/fin4-trigger-b/route.ts","utf8")

// Arm/auth and certification namespace.
need(h.includes('process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1"'),"FIN4 must be production+explicit-arm gated")
need(h.includes('paymentA === paymentB'),"FIN4 must reject identical payments")
need(h.includes('flashpay:cert:fin4:r4:v1:'),"FIN4 R4 must use a fresh certification namespace")
need(h.includes('crypto.timingSafeEqual(a,b)'),"FIN4 run authorization must be timing-safe")
need(h.includes('redis.set(launchKey(runId), "1", { nx: true, ex: LAUNCH_TTL_SECONDS })'),"FIN4 launch must be one-shot NX")
need(h.includes('FIN4_FAIL_CLOSED_LAUNCH_ALREADY_CLAIMED'),"FIN4 duplicate launch must fail closed")
need(h.includes('CONTROLLED_LAUNCH_REQUIRED')&&h.includes('FIN4_FAIL_CLOSED_CONTROLLED_LAUNCH_REQUIRED'),"armed payments must be held before controlled launch")

// Real collision barrier remains immediately before the real source-wallet lock.
need(h.includes('aProcess !== bProcess && aWallet === sourceWallet && bWallet === sourceWallet'),"FIN4 barrier must require distinct processes and same source wallet")
need(h.includes('FIN4_FAIL_CLOSED_DISTINCT_PROCESS_BARRIER_TIMEOUT'),"FIN4 barrier must fail closed")
need(!h.includes('submitTransaction(') && !h.includes('claimPiWalletIntent(') && !h.includes('releasePiWalletIntent('),"FIN4 harness must have no financial authority")
const barrier=a.indexOf('fin4BeforeWalletLock(ctx.paymentId, appPublicKey)')
const lock=a.indexOf('acquirePiWalletIntentSubmitLock(appPublicKey',barrier)
const submit=a.indexOf('moveStage2UnderHeldWalletLock(horizonServer, transaction, preparedHash)',lock)
need(barrier>=0&&lock>barrier&&submit>lock,"FIN4 must observe the existing production lock before the existing submit")
need(a.includes('fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"'),"post-movement telemetry must remain best-effort")
const durable=a.indexOf('recordSettlementHorizonCheckpoint({',submit)
const verified=a.indexOf('fin4BestEffortEvent(ctx.paymentId, appPublicKey, fin4State, "SUBMIT_VERIFIED"',durable)
need(durable>=0&&verified>durable,"FIN4 post-movement telemetry must run only after durable Horizon checkpoint")
need(!a.includes('"LOCK_RELEASING"'),"no FIN4 telemetry may be awaited before the real wallet lock release")
const release=a.indexOf('await walletLock.release()')
const released=a.indexOf('fin4BestEffortEvent(ctx.paymentId, ctx.payment.a2uFromAddress, fin4State, "LOCK_RELEASED")',release)
need(release>=0&&released>release,"FIN4 release telemetry must run only after the real wallet lock is released")

// R3 uses two distinct Vercel route functions and one orchestrator that launches both concurrently.
need(o.includes('Promise.all([invokeRole(origin, runId, "A"), invokeRole(origin, runId, "B")])'),"R3 launch must fan out concurrently to A and B")
need(o.includes('process.env.VERCEL_URL')&&o.includes('/api/certification/fin4-trigger-${role.toLowerCase()}'),"R3 launch must target the exact deployment-specific origin and split routes")
need(!o.includes('executeA2URecovery(')&&!o.includes('submitTransaction('),"R3 orchestrator must have no financial executor or submit authority")
for(const [src,role] of [[ra,'A'],[rb,'B']] as const){
  need(src.includes(`fin4ArmedPaymentForRole(runId, "${role}")`),`split ${role} must derive its fixed armed payment`)
  need(src.includes('fin4RequireControlledLaunch(runId)'),`split ${role} must require the one-shot launch claim`)
  need(src.includes('executeA2URecovery(paymentId)'),`split ${role} must delegate only to existing recovery`)
  need(!src.includes('body.paymentId')&&!src.includes('body.role')&&!src.includes('submitTransaction('),`split ${role} must accept no client payment/role or financial submit implementation`)
}

// Confirmed hot-path timestamp liveness defect closure: new /complete uses PostgreSQL times,
// and existing pre-A2U drift can self-heal only after exact durable+Pi proof with no movement/refund evidence.
need(c.includes('getDurableU2AIngressAuthoritative')&&c.includes('durableCanonicalTimes'),"/complete must read canonical durable U2A timestamps")
need(c.includes('payment.payerUidCapturedAt = durableCanonicalTimes?.verifiedAt')&&c.includes('payment.paidAt = durableCanonicalTimes.completedAt'),"/complete must seed Redis from durable verified/completed timestamps")
need(l.includes('isF24PreA2UTimestampRepairSafe')&&l.includes('financialMovementExecuted: false'),"F2-4 repair must be explicitly pre-A2U/non-movement")
need(l.includes('current.a2uPaymentId~=nil or current.a2uTxid~=nil')&&l.includes('current.refundPaymentId~=nil or current.refundTxid~=nil'),"F2-4 repair must reject advanced Settlement/Refund evidence")
need(l.includes('current.redisProjectionVersion~=version then return 0'),"F2-4 repair must fence the Redis projection version")
need(l.includes('const repairArgs: [string, string, string, string, string, string, string, string, string, string]'),"F2-4 repair args must be an exact ten-string tuple")
need(l.includes('redis.eval<[string, string, string, string, string, string, string, string, string, string], number>'),"F2-4 Redis eval generic must exactly match ten ARGV values")
need(l.includes('typeof payment.merchantUid !== "string"')&&l.includes('typeof payment.piPaymentId !== "string"')&&l.includes('typeof payment.u2aTxid !== "string"')&&l.includes('typeof payment.payerUid !== "string"'),"F2-4 repair must narrow optional identity fields before Redis eval")
need(l.includes('exactPiAuthority')&&l.includes('transaction?.verified === true')&&l.includes('status?.developer_completed === true'),"F2-4 repair must require exact canonical Pi proof")
need(l.includes('payment.payerUidCapturedAt === d.verifiedAt && payment.paidAt === d.completedAt && payment.settlementDispatchRequestedAt === d.completedAt'),"F2-4 authority must retain exact durable timestamp equality")

console.log("FIN4_LIVE_CERTIFICATION_HARNESS_R4=PASS split_functions=true one_shot_launch=true distinct_process_barrier=true financial_authority=false timestamp_hotpath_canonical=true timestamp_self_heal_pre_a2u_only=true telemetry_after_durable=true release_before_telemetry=true")
