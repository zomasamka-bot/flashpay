import "server-only"

import crypto from "crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { isRedisConfigured, redis } from "./redis"

const PROCESS_ID = crypto.randomUUID()
const PREFIX = "flashpay:cert:fin4:r4e:v1:"
const CAPABILITY_VERSION = "fin4-r4e-v1"
const LAUNCH_TTL_SECONDS = 3600
const CAPABILITY_USE_TTL_SECONDS = 300
const CAPABILITY_TTL_MS = 60_000
const CAPABILITY_CLOCK_SKEW_MS = 5_000
const BARRIER_TIMEOUT_MS = 20_000
const POLL_MS = 100

type Fin4Role = "A" | "B"
type Fin4Config = { runId: string; paymentA: string; paymentB: string }
type Fin4Event = { ts: string; event: string; runId: string; paymentId: string; sourceWallet: string; processId: string; invocationId: string; data?: Record<string, unknown> }
type Fin4InvocationCapability = {
  v: typeof CAPABILITY_VERSION
  runId: string
  role: Fin4Role
  paymentId: string
  deploymentHost: string
  iat: number
  exp: number
  nonce: string
}

const invocationCapabilityContext = new AsyncLocalStorage<Fin4InvocationCapability>()

function configFor(paymentId: string): Fin4Config | null {
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1") return null
  const runId = process.env.FLASHPAY_FIN4_RUN_ID?.trim()
  const paymentA = process.env.FLASHPAY_FIN4_PAYMENT_A?.trim()
  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim()
  if (!runId || !paymentA || !paymentB || paymentA === paymentB || !/^[A-Za-z0-9._:-]{8,128}$/.test(runId)) return null
  if (paymentId !== paymentA && paymentId !== paymentB) return null
  return { runId, paymentA, paymentB }
}

function safeWallet(sourceWallet: unknown): sourceWallet is string {
  return typeof sourceWallet === "string" && /^[A-Z0-9]{20,80}$/.test(sourceWallet)
}

function launchKey(runId: string): string {
  return `${PREFIX}${runId}:launch-claimed`
}

function capabilityUseKey(capability: Fin4InvocationCapability): string {
  return `${PREFIX}${capability.runId}:capability-used:${capability.role}:${capability.nonce}`
}

function exactDeploymentHost(): string {
  const host = process.env.VERCEL_URL?.trim() ?? ""
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/.test(host)) throw new Error("FIN4_FAIL_CLOSED_DEPLOYMENT_ORIGIN_UNAVAILABLE")
  return host
}

function automationBypassSecret(): string {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? ""
  if (!/^[A-Za-z0-9]{32}$/.test(secret)) throw new Error("FIN4_FAIL_CLOSED_AUTOMATION_BYPASS_UNAVAILABLE")
  return secret
}

function capabilitySignature(encodedPayload: string): string {
  return crypto.createHmac("sha256", automationBypassSecret())
    .update(`flashpay-fin4-r4e-capability:${encodedPayload}`)
    .digest("base64url")
}

function timingSafeEqualText(a: string, b: string): boolean {
  const aa = Buffer.from(a)
  const bb = Buffer.from(b)
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

function exactCapabilityShape(value: unknown): value is Fin4InvocationCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(",")
  return keys === "deploymentHost,exp,iat,nonce,paymentId,role,runId,v" &&
    record.v === CAPABILITY_VERSION &&
    (record.role === "A" || record.role === "B") &&
    typeof record.runId === "string" &&
    typeof record.paymentId === "string" &&
    typeof record.deploymentHost === "string" &&
    typeof record.iat === "number" && Number.isSafeInteger(record.iat) &&
    typeof record.exp === "number" && Number.isSafeInteger(record.exp) &&
    typeof record.nonce === "string"
}

export function fin4AuthorizeRunId(providedRaw: string | null): string | null {
  const expected = process.env.FLASHPAY_FIN4_RUN_ID?.trim()
  const provided = providedRaw?.trim()
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1" || !expected || !provided) return null
  const a = Buffer.from(expected), b = Buffer.from(provided)
  return a.length === b.length && crypto.timingSafeEqual(a,b) ? expected : null
}

export function fin4AutomationBypassPresent(): boolean {
  try {
    automationBypassSecret()
    return true
  } catch {
    return false
  }
}

// Redis is certification coordination/audit only. It does not authorize settlement/refund movement.
export async function fin4ClaimLaunchForArmedRun(runId: string): Promise<{ paymentA: string; paymentB: string }> {
  const paymentA = process.env.FLASHPAY_FIN4_PAYMENT_A?.trim() ?? ""
  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim() ?? ""
  if (fin4AuthorizeRunId(runId) !== runId || !paymentA || !paymentB || paymentA === paymentB || !isRedisConfigured) {
    throw new Error("FIN4_FAIL_CLOSED_LAUNCH_NOT_ARMED")
  }
  const claimed = await redis.set(launchKey(runId), "1", { nx: true, ex: LAUNCH_TTL_SECONDS })
  if (claimed !== "OK") throw new Error("FIN4_FAIL_CLOSED_LAUNCH_ALREADY_CLAIMED")
  console.log("[FIN-4 LIVE] controlled launch claimed", { runId, paymentA, paymentB, financialAuthorityMutated: false, redisPurpose: "audit_and_one_shot_coordination_only" })
  return { paymentA, paymentB }
}

export function fin4ArmedPaymentForRole(runId: string, role: unknown): string {
  const paymentA = process.env.FLASHPAY_FIN4_PAYMENT_A?.trim() ?? ""
  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim() ?? ""
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1" ||
      runId !== process.env.FLASHPAY_FIN4_RUN_ID?.trim() || !paymentA || !paymentB || paymentA === paymentB) {
    throw new Error("FIN4_TRIGGER_FAIL_CLOSED_NOT_ARMED")
  }
  if (role === "A") return paymentA
  if (role === "B") return paymentB
  throw new Error("FIN4_TRIGGER_FAIL_CLOSED_INVALID_ROLE")
}

export function fin4IssueInvocationCapability(runId: string, role: Fin4Role): string {
  if (fin4AuthorizeRunId(runId) !== runId) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_NOT_ARMED")
  const paymentId = fin4ArmedPaymentForRole(runId, role)
  const iat = Date.now()
  const payload: Fin4InvocationCapability = {
    v: CAPABILITY_VERSION,
    runId,
    role,
    paymentId,
    deploymentHost: exactDeploymentHost(),
    iat,
    exp: iat + CAPABILITY_TTL_MS,
    nonce: crypto.randomUUID(),
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${encoded}.${capabilitySignature(encoded)}`
}

export function fin4ValidateInvocationCapability(tokenRaw: string | null, runId: string, role: Fin4Role, paymentId: string): Fin4InvocationCapability {
  const token = tokenRaw?.trim() ?? ""
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_MISSING_OR_MALFORMED")
  const [encoded, suppliedSignature] = parts
  const expectedSignature = capabilitySignature(encoded)
  if (!timingSafeEqualText(suppliedSignature, expectedSignature)) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_SIGNATURE")

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_PAYLOAD")
  }
  if (!exactCapabilityShape(parsed)) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_SHAPE")

  const expectedPayment = fin4ArmedPaymentForRole(runId, role)
  const expectedHost = exactDeploymentHost()
  const now = Date.now()
  if (parsed.runId !== runId || parsed.role !== role || parsed.paymentId !== paymentId || paymentId !== expectedPayment || parsed.deploymentHost !== expectedHost) {
    throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_SCOPE")
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.nonce)) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_NONCE")
  if (parsed.exp <= parsed.iat || parsed.exp - parsed.iat !== CAPABILITY_TTL_MS || parsed.iat > now + CAPABILITY_CLOCK_SKEW_MS || now > parsed.exp) {
    throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_TIME")
  }
  return parsed
}

// One-shot consumption is harness coordination only; the signed capability is the invocation authorization.
export async function fin4ConsumeInvocationCapability(capability: Fin4InvocationCapability): Promise<void> {
  if (!isRedisConfigured) throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_REDIS_UNAVAILABLE")
  const consumed = await redis.set(capabilityUseKey(capability), "1", { nx: true, ex: CAPABILITY_USE_TTL_SECONDS })
  if (consumed !== "OK") throw new Error("FIN4_CAPABILITY_FAIL_CLOSED_ALREADY_USED")
  console.log("[FIN-4 LIVE] scoped capability consumed", {
    runId: capability.runId,
    role: capability.role,
    paymentId: capability.paymentId,
    deploymentHost: capability.deploymentHost,
    financialAuthorityMutated: false,
    redisPurpose: "audit_and_one_shot_coordination_only",
  })
}

export async function fin4RunWithInvocationCapability<T>(capability: Fin4InvocationCapability, work: () => Promise<T>): Promise<T> {
  return await invocationCapabilityContext.run(capability, work)
}

async function emit(cfg: Fin4Config, event: Omit<Fin4Event,"ts"|"runId"|"processId">): Promise<void> {
  const record: Fin4Event = { ts: new Date().toISOString(), runId: cfg.runId, processId: PROCESS_ID, ...event }
  await redis.rpush(`${PREFIX}${cfg.runId}:events`, JSON.stringify(record))
  console.log("[FIN-4 LIVE]", record)
}

export async function fin4BeforeWalletLock(paymentId: string, sourceWallet: unknown): Promise<{ invocationId: string } | null> {
  const cfg = configFor(paymentId)
  if (!cfg) return null
  if (!isRedisConfigured || !safeWallet(sourceWallet)) throw new Error("FIN4_FAIL_CLOSED_INVALID_RUNTIME")
  const invocationId = crypto.randomUUID()
  const capability = invocationCapabilityContext.getStore()
  if (!capability || capability.runId !== cfg.runId || capability.paymentId !== paymentId || fin4ArmedPaymentForRole(cfg.runId, capability.role) !== paymentId) {
    await emit(cfg,{ event:"SCOPED_CAPABILITY_REQUIRED", paymentId, sourceWallet, invocationId })
    throw new Error("FIN4_FAIL_CLOSED_SCOPED_CAPABILITY_REQUIRED")
  }
  const participantKey = `${PREFIX}${cfg.runId}:participant:${paymentId}`
  const releasedKey = `${PREFIX}${cfg.runId}:barrier-released`
  if (await redis.get<string>(releasedKey) === "1") {
    await emit(cfg,{ event:"BARRIER_REENTRY", paymentId, sourceWallet, invocationId })
    return { invocationId }
  }
  const participantValue = `${PROCESS_ID}|${sourceWallet}`
  const existing = await redis.get<string>(participantKey)
  if (existing && existing !== participantValue) throw new Error("FIN4_FAIL_CLOSED_PAYMENT_REENTERED_BEFORE_BARRIER")
  await redis.set(participantKey, participantValue, { ex: 900 })
  await emit(cfg,{ event:"BARRIER_ARRIVED", paymentId, sourceWallet, invocationId, data:{ capabilityRole:capability.role, capabilityScopeVerified:true } })
  const deadline = Date.now() + BARRIER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const [a,b] = await Promise.all([
      redis.get<string>(`${PREFIX}${cfg.runId}:participant:${cfg.paymentA}`),
      redis.get<string>(`${PREFIX}${cfg.runId}:participant:${cfg.paymentB}`),
    ])
    if (a && b) {
      const [aProcess,aWallet] = a.split("|")
      const [bProcess,bWallet] = b.split("|")
      if (aProcess !== bProcess && aWallet === sourceWallet && bWallet === sourceWallet) {
        await redis.set(releasedKey, "1", { ex: 900 })
        await emit(cfg,{ event:"BARRIER_RELEASED", paymentId, sourceWallet, invocationId, data:{ distinctProcesses:true, sameSourceWallet:true, scopedCapabilities:true } })
        return { invocationId }
      }
    }
    await new Promise(resolve=>setTimeout(resolve,POLL_MS))
  }
  await emit(cfg,{ event:"BARRIER_TIMEOUT", paymentId, sourceWallet, invocationId })
  throw new Error("FIN4_FAIL_CLOSED_DISTINCT_PROCESS_BARRIER_TIMEOUT")
}

export async function fin4Event(paymentId: string, sourceWallet: unknown, state: { invocationId: string } | null, event: string, data?: Record<string, unknown>): Promise<void> {
  if (!state) return
  const cfg = configFor(paymentId)
  if (!cfg || !isRedisConfigured || !safeWallet(sourceWallet)) throw new Error("FIN4_FAIL_CLOSED_TELEMETRY_UNAVAILABLE")
  await emit(cfg,{ event, paymentId, sourceWallet, invocationId:state.invocationId, data })
}

export async function fin4BestEffortEvent(paymentId: string, sourceWallet: unknown, state: { invocationId: string } | null, event: string, data?: Record<string, unknown>): Promise<void> {
  try {
    await fin4Event(paymentId, sourceWallet, state, event, data)
  } catch (error) {
    console.warn("[FIN-4 LIVE] best-effort telemetry unavailable", { paymentId, event, error: String(error) })
  }
}
