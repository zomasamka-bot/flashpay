import "server-only"

import crypto from "crypto"
import { isRedisConfigured, redis } from "./redis"

const PROCESS_ID = crypto.randomUUID()
const PREFIX = "flashpay:cert:fin4:r4d:v1:"
const LAUNCH_TTL_SECONDS = 3600
const BARRIER_TIMEOUT_MS = 20_000
const POLL_MS = 100

type Fin4Config = { runId: string; paymentA: string; paymentB: string }
type Fin4Event = { ts: string; event: string; runId: string; paymentId: string; sourceWallet: string; processId: string; invocationId: string; data?: Record<string, unknown> }

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

export function fin4AuthorizeRunId(providedRaw: string | null): string | null {
  const expected = process.env.FLASHPAY_FIN4_RUN_ID?.trim()
  const provided = providedRaw?.trim()
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1" || !expected || !provided) return null
  const a = Buffer.from(expected), b = Buffer.from(provided)
  return a.length === b.length && crypto.timingSafeEqual(a,b) ? expected : null
}

export async function fin4ClaimLaunchForArmedRun(runId: string): Promise<{ paymentA: string; paymentB: string }> {
  const paymentA = process.env.FLASHPAY_FIN4_PAYMENT_A?.trim() ?? ""
  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim() ?? ""
  if (fin4AuthorizeRunId(runId) !== runId || !paymentA || !paymentB || paymentA === paymentB || !isRedisConfigured) {
    throw new Error("FIN4_FAIL_CLOSED_LAUNCH_NOT_ARMED")
  }
  const claimed = await redis.set(launchKey(runId), "1", { nx: true, ex: LAUNCH_TTL_SECONDS })
  if (claimed !== "OK") throw new Error("FIN4_FAIL_CLOSED_LAUNCH_ALREADY_CLAIMED")
  console.log("[FIN-4 LIVE] controlled launch claimed", { runId, paymentA, paymentB, financialAuthorityMutated: false })
  return { paymentA, paymentB }
}

export async function fin4RequireControlledLaunch(runId: string): Promise<void> {
  if (!isRedisConfigured || await redis.get<string>(launchKey(runId)) !== "1") throw new Error("FIN4_FAIL_CLOSED_CONTROLLED_LAUNCH_REQUIRED")
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
  if (await redis.get<string>(launchKey(cfg.runId)) !== "1") {
    await emit(cfg,{ event:"CONTROLLED_LAUNCH_REQUIRED", paymentId, sourceWallet, invocationId })
    throw new Error("FIN4_FAIL_CLOSED_CONTROLLED_LAUNCH_REQUIRED")
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
  await emit(cfg,{ event:"BARRIER_ARRIVED", paymentId, sourceWallet, invocationId })
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
      await emit(cfg,{ event:"BARRIER_RELEASED", paymentId, sourceWallet, invocationId, data:{ distinctProcesses:true, sameSourceWallet:true } })
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
