import "server-only"

import crypto from "crypto"
import { isRedisConfigured, redis } from "./redis"

const PROCESS_ID = crypto.randomUUID()
const PREFIX = "flashpay:cert:fin4:v1:"
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

export async function fin4ResetBarrierForArmedRun(runId: string): Promise<{ paymentA: string; paymentB: string }> {
  const paymentA = process.env.FLASHPAY_FIN4_PAYMENT_A?.trim() ?? ""
  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim() ?? ""
  if (process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1" ||
      runId !== process.env.FLASHPAY_FIN4_RUN_ID?.trim() || !paymentA || !paymentB || paymentA === paymentB || !isRedisConfigured) {
    throw new Error("FIN4_TRIGGER_FAIL_CLOSED_NOT_ARMED")
  }
  await Promise.all([
    redis.del(`${PREFIX}${runId}:participant:${paymentA}`),
    redis.del(`${PREFIX}${runId}:participant:${paymentB}`),
    redis.del(`${PREFIX}${runId}:barrier-released`),
  ])
  console.log("[FIN-4 LIVE] barrier reset", { runId, paymentA, paymentB, financialAuthorityMutated: false })
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
