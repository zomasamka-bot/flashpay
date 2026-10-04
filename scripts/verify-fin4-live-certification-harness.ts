import fs from "node:fs"
const need=(v:unknown,m:string)=>{if(!v)throw new Error(m)}
const h=fs.readFileSync("lib/fin4-live-certification.ts","utf8")
const a=fs.readFileSync("lib/a2u-executor.ts","utf8")
const l=fs.readFileSync("lib/a2u-locked-executor.ts","utf8")
const c=fs.readFileSync("app/api/pi/complete/route.ts","utf8")
const o=fs.readFileSync("app/api/certification/fin4-trigger/route.ts","utf8")
const ra=fs.readFileSync("app/api/certification/fin4-trigger-a/route.ts","utf8")
const rb=fs.readFileSync("app/api/certification/fin4-trigger-b/route.ts","utf8")

// Arm/auth and fresh certification namespace. Old R4D/R4D1 claims remain evidence and are never reset.
need(h.includes('process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1"'),"FIN4 must be production+explicit-arm gated")
need(h.includes('paymentA === paymentB'),"FIN4 must reject identical payments")
need(h.includes('flashpay:cert:fin4:r4e:v1:'),"FIN4 R4E must use a fresh certification namespace")
need(!h.includes('flashpay:cert:fin4:r4d:v1:'),"R4E runtime harness must not reuse the consumed R4D namespace")
need(h.includes('crypto.timingSafeEqual(a,b)'),"FIN4 run authorization must remain timing-safe")
need(h.includes('redis.set(launchKey(runId), "1", { nx: true, ex: LAUNCH_TTL_SECONDS })'),"FIN4 launch must remain one-shot NX coordination")
need(h.includes('redisPurpose: "audit_and_one_shot_coordination_only"'),"Redis launch/capability writes must be explicitly non-financial coordination")
need(h.includes('FIN4_FAIL_CLOSED_LAUNCH_ALREADY_CLAIMED'),"FIN4 duplicate launch must fail closed")

// R4E signed, short-lived, role/payment/deployment-scoped capability.
need(h.includes('import { AsyncLocalStorage } from "node:async_hooks"'),"R4E must carry verified capability through the invocation without Redis read-after-write authorization")
need(h.includes('const CAPABILITY_VERSION = "fin4-r4e-v1"'),"R4E capability must be versioned")
need(h.includes('const CAPABILITY_TTL_MS = 60_000'),"R4E capability must be short-lived")
need(h.includes('crypto.createHmac("sha256", automationBypassSecret())'),"R4E capability must be HMAC authenticated with the server-only automation secret")
need(h.includes('flashpay-fin4-r4e-capability:${encodedPayload}'),"R4E capability HMAC must use domain separation")
need(h.includes('deploymentHost: exactDeploymentHost()')&&h.includes('role,')&&h.includes('paymentId,')&&h.includes('runId,'),"R4E issued capability must bind run, role, payment, and exact deployment")
need(h.includes('nonce: crypto.randomUUID()'),"R4E capability must include a high-entropy nonce")
need(h.includes('timingSafeEqualText(suppliedSignature, expectedSignature)'),"R4E capability signature comparison must be timing-safe")
need(h.includes('parsed.runId !== runId || parsed.role !== role || parsed.paymentId !== paymentId')&&h.includes('parsed.deploymentHost !== expectedHost'),"R4E validation must reject run/role/payment/deployment scope mismatch")
need(h.includes('parsed.exp - parsed.iat !== CAPABILITY_TTL_MS')&&h.includes('now > parsed.exp'),"R4E validation must enforce exact TTL and expiry")
need(h.includes('redis.set(capabilityUseKey(capability), "1", { nx: true, ex: CAPABILITY_USE_TTL_SECONDS })'),"R4E capability use must be one-shot coordinated with atomic NX write")
need(h.includes('invocationCapabilityContext.run(capability, work)'),"R4E verified capability must be bound to the recovery invocation context")
need(h.includes('const capability = invocationCapabilityContext.getStore()'),"wallet-lock boundary must require the verified invocation context")
need(h.includes('FIN4_FAIL_CLOSED_SCOPED_CAPABILITY_REQUIRED'),"wallet-lock boundary must fail closed without scoped capability")
need(!h.includes('redis.get<string>(launchKey('),"R4E must not authorize the financial-boundary harness by reading the launch claim")
need(!h.includes('fin4RequireControlledLaunch'),"R4E must remove the stale-read launch-claim gate from A/B")

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

// Protected split routes receive role-specific capabilities from the orchestrator; tokens are never logged/returned.
need(o.includes('process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()')&&o.includes('FIN4_FAIL_CLOSED_AUTOMATION_BYPASS_UNAVAILABLE'),"R4E must fail closed without Vercel automation bypass")
need(o.includes('"x-vercel-protection-bypass": bypassSecret'),"R4E split-function calls must use official Vercel automation bypass header")
need(o.includes('"x-flashpay-fin4-capability": capability'),"R4E split-function calls must carry the scoped capability")
need(o.includes('const capabilityA = fin4IssueInvocationCapability(runId, "A")')&&o.includes('const capabilityB = fin4IssueInvocationCapability(runId, "B")'),"orchestrator must issue independent A/B capabilities")
need(o.indexOf('fin4ClaimLaunchForArmedRun(runId)') < o.indexOf('fin4IssueInvocationCapability(runId, "A")'),"capabilities must only be issued after one-shot launch claim")
need(o.includes('Promise.all([\n      invokeRole(origin, runId, "A", bypassSecret, capabilityA),\n      invokeRole(origin, runId, "B", bypassSecret, capabilityB),\n    ])'),"R4E launch must fan out concurrently with independent A/B capabilities")
need(o.includes('process.env.VERCEL_URL')&&o.includes('/api/certification/fin4-trigger-${role.toLowerCase()}'),"R4E launch must target exact deployment-specific origin")
need(!o.includes('console.log(capabilityA)')&&!o.includes('console.log(capabilityB)')&&!o.includes('payload: capability')&&!o.includes('capability: capability'),"R4E must never log or return capability tokens")
need(!o.includes('executeA2URecovery(')&&!o.includes('submitTransaction('),"R4E orchestrator must have no financial executor or submit authority")

// Read-only bypass preflight remains non-financial and non-launching.
need(o.includes('export async function GET(request: NextRequest)')&&o.includes('action: "preflight"')&&o.includes('automationBypassPresent: present')&&o.includes('financialAuthorityMutated: false'),"R4E must preserve authorized read-only bypass preflight")
const preflightStart=o.indexOf('export async function GET(request: NextRequest)')
const preflightEnd=o.indexOf('async function invokeRole(',preflightStart)
const preflight=o.slice(preflightStart,preflightEnd)
need(!preflight.includes('fin4ClaimLaunchForArmedRun')&&!preflight.includes('redis.')&&!preflight.includes('fetch(')&&!preflight.includes('executeA2URecovery')&&!preflight.includes('submitTransaction('),"R4E preflight must have zero launch, Redis, network, recovery, or financial side effects")

for(const [src,role] of [[ra,'A'],[rb,'B']] as const){
  need(src.includes(`fin4ArmedPaymentForRole(runId, "${role}")`),`split ${role} must derive its fixed armed payment`)
  need(src.includes(`fin4ValidateInvocationCapability(request.headers.get("x-flashpay-fin4-capability"), runId, "${role}", paymentId)`),`split ${role} must validate exact scoped capability`)
  need(src.includes('await fin4ConsumeInvocationCapability(capability)'),`split ${role} must consume capability exactly once`)
  need(src.includes('fin4RunWithInvocationCapability(capability, async () =>'),`split ${role} must bind verified capability to recovery async context`)
  need(src.includes('executeA2URecovery(paymentId)'),`split ${role} must delegate only to existing recovery`)
  need(!src.includes('body.paymentId')&&!src.includes('body.role')&&!src.includes('submitTransaction('),`split ${role} must accept no client payment/role or financial submit implementation`)
  need(!src.includes('fin4RequireControlledLaunch'),`split ${role} must not depend on Redis launch-claim reads`)
}

// Previously closed durable-timestamp fix remains intact.
need(c.includes('getDurableU2AIngressAuthoritative')&&c.includes('durableCanonicalTimes'),"/complete must read canonical durable U2A timestamps")
need(c.includes('const ingressCompletedAt = ingress.completedAt')&&c.includes('if (ingressCompletedAt === null ||'),"/complete must explicitly narrow nullable durable completedAt before use")
need(c.includes('payment.payerUidCapturedAt = durableCanonicalTimes?.verifiedAt')&&c.includes('payment.paidAt = durableCanonicalTimes.completedAt'),"/complete must seed Redis from durable verified/completed timestamps")
need(l.includes('isF24PreA2UTimestampRepairSafe')&&l.includes('financialMovementExecuted: false'),"F2-4 repair must remain explicitly pre-A2U/non-movement")
need(l.includes('current.a2uPaymentId~=nil or current.a2uTxid~=nil')&&l.includes('current.refundPaymentId~=nil or current.refundTxid~=nil'),"F2-4 repair must reject advanced Settlement/Refund evidence")
need(l.includes('current.redisProjectionVersion~=version then return 0'),"F2-4 repair must fence Redis projection version")
need(l.includes('const repairArgs: [string, string, string, string, string, string, string, string, string, string]'),"F2-4 repair args must remain exact ten-string tuple")
need(l.includes('const completedAt = d.completedAt')&&l.includes('if (completedAt === null) return null'),"F2-4 authority must retain nullable durable completedAt narrowing")

console.log("FIN4_LIVE_CERTIFICATION_HARNESS_R4E=PASS split_functions=true one_shot_launch=true scoped_hmac_capabilities=true async_context_boundary=true redis_launch_read_authority=false redis_coordination_only=true distinct_process_barrier=true financial_authority=false telemetry_after_durable=true release_before_telemetry=true")
