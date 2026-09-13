import { randomUUID, timingSafeEqual } from "crypto"
import { type NextRequest, NextResponse } from "next/server"

import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { isStage1OnlySettlementDispatchCandidate } from "@/lib/a2u-locked-executor"
import { ensureAutomaticRefundIntent, readAutomaticRefundDrainHead, runAutomaticRefundPass } from "@/lib/refund-auto-orchestrator"
import { query } from "@/lib/db"
import { isRefundEligible as checkRefundEligibility } from "@/lib/types"
import { reconcileIncompleteA2UPayment } from "@/lib/pi-reconciliation"
import type { Payment } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_ATTEMPTS = 5
const BOUNDED_PIPELINE_CONCURRENCY = 2
const WALLET_DRAIN_BURST_LIMIT = 5
const WALLET_DRAIN_BURST_BUDGET_MS = 60_000
const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"
const DRAIN_LEASE_KEY = "flashpay:recovery:transient:drain-lease:v1"
const DRAIN_LEASE_TTL_SECONDS = 900
const PI_CREATE_BACKPRESSURE_KEY = "flashpay:recovery:pi-create-backpressure:v1"
const PI_CREATE_BACKPRESSURE_FALLBACK_MS = 15 * 60_000
const DRAIN_LEASE_RELEASE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`
const DRAIN_LEASE_RENEW_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current ~= ARGV[1] then return 0 end
return redis.call("EXPIRE", KEYS[1], ARGV[2])
`

type DrainLease = {
  state: "acquired"
  renew: () => Promise<boolean>
  release: () => Promise<boolean>
} | { state: "busy" } | { state: "unavailable" }

type BoundedPipelineTaskResult<T> = { value?: T; stop?: boolean }
type RecoveryPipelineValue = { paymentId: string; ok: boolean; status?: string; error?: string }
type WalletDrainFairnessClass = "fresh" | "reconciling" | "refund"
type WalletDrainLane = "prepared" | WalletDrainFairnessClass

const WALLET_DRAIN_FAIRNESS_ORDER: readonly WalletDrainFairnessClass[] = ["fresh", "reconciling", "refund"]

function walletDrainFairnessClassForGeneration(generation: number | null): WalletDrainFairnessClass | null {
  if (generation === null || !Number.isSafeInteger(generation) || generation < 1) return null
  return WALLET_DRAIN_FAIRNESS_ORDER[(generation - 1) % WALLET_DRAIN_FAIRNESS_ORDER.length]
}

async function runBoundedOrderedPipeline<T>(items: string[], handler: (id: string) => Promise<BoundedPipelineTaskResult<T>>): Promise<{ values: T[]; peakInFlight: number }> {
  if (items.length === 0) return { values: [], peakInFlight: 0 }

  const ordered: Array<T | undefined> = new Array(items.length)
  let nextIndex = 0
  let stopped = false
  let inFlight = 0
  let peakInFlight = 0

  const runWorker = async () => {
    while (true) {
      if (stopped) return
      const index = nextIndex
      if (index >= items.length) return
      nextIndex++
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        const result = await handler(items[index])
        if (result.value !== undefined) ordered[index] = result.value
        if (result.stop === true) stopped = true
      } finally {
        inFlight--
      }
    }
  }

  const workers: Promise<void>[] = []
  const workerCount = Math.min(BOUNDED_PIPELINE_CONCURRENCY, items.length)
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) workers.push(runWorker())
  const outcomes = await Promise.allSettled(workers)
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason

  const values: T[] = []
  for (const value of ordered) if (value !== undefined) values.push(value)
  return { values, peakInFlight }
}

type PiCreateBackpressureState =
  | { state: "inactive" }
  | { state: "active"; untilMs: number }
  | { state: "unavailable" }

async function readPiCreateBackpressure(now: number): Promise<PiCreateBackpressureState> {
  try {
    const value = await redis.get<unknown>(PI_CREATE_BACKPRESSURE_KEY)
    if (value === null) return { state: "inactive" }
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return { state: "unavailable" }
    const untilMs = Number(value)
    if (!Number.isSafeInteger(untilMs) || untilMs < 0) return { state: "unavailable" }
    return untilMs > now ? { state: "active", untilMs } : { state: "inactive" }
  } catch {
    return { state: "unavailable" }
  }
}

async function extendPiCreateBackpressure(nextRetryAt: string | undefined, now: number): Promise<number | null> {
  const parsedRetryAt = typeof nextRetryAt === "string" && nextRetryAt.trim() !== "" && nextRetryAt === nextRetryAt.trim() ? Date.parse(nextRetryAt) : NaN
  const candidateUntilMs = Math.max(now + PI_CREATE_BACKPRESSURE_FALLBACK_MS, Number.isFinite(parsedRetryAt) && parsedRetryAt > now ? parsedRetryAt : 0)
  try {
    const result = await redis.eval<[string, string], number>(`
local candidate=tonumber(ARGV[1])
local now=tonumber(ARGV[2])
if not candidate or not now or candidate <= now then return -1 end
local current=redis.call("GET",KEYS[1])
if current then
  local currentNumber=tonumber(current)
  if not currentNumber then return -1 end
  if currentNumber > candidate then candidate=currentNumber end
end
local ttl=math.ceil((candidate-now)/1000)
if ttl < 1 then ttl=1 end
redis.call("SET",KEYS[1],tostring(candidate),"EX",ttl)
return candidate
`, [PI_CREATE_BACKPRESSURE_KEY], [String(candidateUntilMs), String(now)])
    return Number.isSafeInteger(result) && result > now ? result : null
  } catch {
    return null
  }
}

function isPiCreateBackpressureSignal(payment: Payment): boolean {
  return payment.a2uErrorCode === "too_many_payments" || payment.a2uErrorCode === "uid_verification_429"
}

async function acquireTransientDrainLease(): Promise<DrainLease> {
  const token = randomUUID()
  try {
    const acquired = await redis.set(DRAIN_LEASE_KEY, token, { nx: true, ex: DRAIN_LEASE_TTL_SECONDS })
    if (acquired !== "OK") return { state: "busy" }
  } catch {
    return { state: "unavailable" }
  }

  let released = false
  return {
    state: "acquired",
    renew: async () => {
      if (released) return false
      try {
        const result = await redis.eval<[string, string], number>(DRAIN_LEASE_RENEW_SCRIPT, [DRAIN_LEASE_KEY], [token, String(DRAIN_LEASE_TTL_SECONDS)])
        return result === 1
      } catch {
        return false
      }
    },
    release: async () => {
      if (released) return true
      released = true
      try {
        const result = await redis.eval<[string], number>(DRAIN_LEASE_RELEASE_SCRIPT, [DRAIN_LEASE_KEY], [token])
        return result === 1
      } catch {
        return false
      }
    },
  }
}

function hasValidSecret(request: NextRequest): boolean {
  const expected = process.env[RECOVERY_SECRET_ENV]
  const provided = request.headers.get("x-flashpay-transient-recovery-secret")

  if (!expected || !provided) return false

  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  if (expectedBuffer.length !== providedBuffer.length) return false

  return timingSafeEqual(expectedBuffer, providedBuffer)
}

function parsePayment(value: unknown): Payment | null {
  if (!value) return null
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value
    return parsed && typeof parsed === "object" ? (parsed as Payment) : null
  } catch {
    return null
  }
}

function hasExcludedState(payment: Payment): boolean {
  return (
    payment.settlementFailureState === "held" ||
    payment.settlementFailureState === "manual_review_required" ||
    payment.settlementFailureState === "refund_pending" ||
    payment.settlementFailureState === "refunded" ||
    payment.refundStatus === "pending" ||
    payment.refundStatus === "submitted" ||
    payment.refundStatus === "completed" ||
    payment.refundStatus === "manual_review_required"
  )
}

function isFreshSettlementDispatchCandidate(payment: Payment, now: number): boolean {
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    typeof payment.accessToken === "string" && payment.accessToken.trim() !== "" && payment.accessToken === payment.accessToken.trim() &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === undefined && payment.retryCount === undefined && payment.lastAttemptAt === undefined && payment.nextRetryAt === undefined &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && payment.a2uErrorCode === undefined && payment.a2uErrorMessage === undefined && payment.a2uErrorBody === undefined && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && payment.refundStatus === undefined && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isStaleFreshReconcilingCandidate(payment: Payment, now: number): boolean {
  const lastAttemptAt = typeof payment.lastAttemptAt === "string" && payment.lastAttemptAt.trim() !== "" && payment.lastAttemptAt === payment.lastAttemptAt.trim() ? Date.parse(payment.lastAttemptAt) : NaN
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    typeof payment.accessToken === "string" && payment.accessToken.trim() !== "" && payment.accessToken === payment.accessToken.trim() &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === "reconciling" && payment.retryCount === 1 && payment.nextRetryAt === undefined &&
    Number.isFinite(lastAttemptAt) && lastAttemptAt <= now - 660000 &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && payment.a2uErrorCode === undefined && payment.a2uErrorMessage === undefined && payment.a2uErrorBody === undefined && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && payment.refundStatus === undefined && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isStaleRetryReconcilingCandidate(payment: Payment, now: number): boolean {
  const lastAttemptAt = typeof payment.lastAttemptAt === "string" && payment.lastAttemptAt.trim() !== "" && payment.lastAttemptAt === payment.lastAttemptAt.trim() ? Date.parse(payment.lastAttemptAt) : NaN
  const nextRetryAt = typeof payment.nextRetryAt === "string" && payment.nextRetryAt.trim() !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() ? Date.parse(payment.nextRetryAt) : NaN
  const dispatchAt = typeof payment.settlementDispatchRequestedAt === "string" && payment.settlementDispatchRequestedAt.trim() !== "" && payment.settlementDispatchRequestedAt === payment.settlementDispatchRequestedAt.trim() ? Date.parse(payment.settlementDispatchRequestedAt) : NaN
  const paidAt = typeof payment.paidAt === "string" && payment.paidAt.trim() !== "" && payment.paidAt === payment.paidAt.trim() ? Date.parse(payment.paidAt) : NaN
  const u2aTxid = payment.u2aTxid
  return (
    payment.status === "paid_to_app" &&
    typeof payment.settlementDispatchRequestedAt === "string" && typeof payment.paidAt === "string" &&
    Number.isFinite(dispatchAt) && Number.isFinite(paidAt) && dispatchAt === paidAt && dispatchAt <= now &&
    typeof payment.amount === "number" && Number.isFinite(payment.amount) && payment.amount > 0 &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 && payment.amount === payment.customerAmount &&
    typeof payment.piPaymentId === "string" && payment.piPaymentId.trim() !== "" && payment.piPaymentId === payment.piPaymentId.trim() &&
    typeof payment.merchantId === "string" && payment.merchantId.trim() !== "" && payment.merchantId === payment.merchantId.trim() &&
    typeof payment.merchantUid === "string" && payment.merchantUid.trim() !== "" && payment.merchantUid === payment.merchantUid.trim() &&
    typeof payment.accessToken === "string" && payment.accessToken.trim() !== "" && payment.accessToken === payment.accessToken.trim() &&
    typeof payment.payerUid === "string" && payment.payerUid.trim() !== "" && payment.payerUid === payment.payerUid.trim() &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" && payment.payerUidCapturedAt.trim() !== "" && payment.payerUidCapturedAt === payment.payerUidCapturedAt.trim() && Number.isFinite(Date.parse(payment.payerUidCapturedAt)) && Date.parse(payment.payerUidCapturedAt) <= now &&
    typeof u2aTxid === "string" && u2aTxid === u2aTxid.trim() && /^[0-9a-f]{64}$/.test(u2aTxid) &&
    payment.a2uTxid === undefined &&
    payment.settlementFailureState === "reconciling" && typeof payment.retryCount === "number" && Number.isInteger(payment.retryCount) && payment.retryCount >= 2 &&
    Number.isFinite(lastAttemptAt) && lastAttemptAt <= now - 660000 && Number.isFinite(nextRetryAt) && nextRetryAt <= lastAttemptAt &&
    payment.a2uPaymentId === undefined && payment.a2uPreparedEnvelopeXdr === undefined && payment.a2uPreparedTxHash === undefined && payment.a2uPreparedSequence === undefined && payment.a2uFromAddress === undefined && payment.a2uToAddress === undefined &&
    payment.merchantAmount === undefined && payment.horizonFeeCharged === undefined && payment.appCommission === undefined && payment.appNetImpact === undefined && (payment.a2uErrorCode === undefined || typeof payment.a2uErrorCode === "string" && payment.a2uErrorCode.trim() !== "") && (payment.a2uErrorMessage === undefined || typeof payment.a2uErrorMessage === "string" && payment.a2uErrorMessage.trim() !== "") && (payment.a2uErrorBody === undefined || typeof payment.a2uErrorBody === "string" && payment.a2uErrorBody.trim() !== "") && payment.horizonSuccessAt === undefined && payment.settledAt === undefined &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && (payment.refundStatus === undefined || payment.refundStatus === "not_started") && payment.refundFailureCode === undefined && payment.refundProof === undefined && payment.payerRefundEligible !== true &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    !hasExcludedState(payment)
  )
}

function isPreparedSubmitEligible(payment: Payment): boolean {
  return (
    payment.status === "settlement_pending" &&
    typeof payment.a2uPaymentId === "string" && payment.a2uPaymentId.trim() !== "" && payment.a2uPaymentId === payment.a2uPaymentId.trim() &&
    typeof payment.a2uPreparedEnvelopeXdr === "string" && payment.a2uPreparedEnvelopeXdr.trim() !== "" && payment.a2uPreparedEnvelopeXdr === payment.a2uPreparedEnvelopeXdr.trim() &&
    typeof payment.a2uFromAddress === "string" && payment.a2uFromAddress.trim() !== "" && payment.a2uFromAddress === payment.a2uFromAddress.trim() &&
    typeof payment.a2uToAddress === "string" && payment.a2uToAddress.trim() !== "" && payment.a2uToAddress === payment.a2uToAddress.trim() &&
    typeof payment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(payment.a2uPreparedTxHash) && payment.a2uPreparedTxHash === payment.a2uPreparedTxHash.trim() &&
    typeof payment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(payment.a2uPreparedSequence) &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 &&
    typeof payment.merchantAmount === "number" && Number.isFinite(payment.merchantAmount) && payment.merchantAmount > 0 &&
    payment.a2uTxid === undefined &&
    payment.horizonSuccessFlag !== true &&
    payment.piCompletionPending !== true &&
    payment.piCompleted !== true &&
    payment.requiresDbReconciliation !== true &&
    payment.dbRecorded !== true &&
    payment.refundPaymentId === undefined &&
    payment.refundTxid === undefined &&
    (payment.refundStatus === undefined || payment.refundStatus === "not_started") &&
    !hasExcludedState(payment)
  )
}

function isEligible(payment: Payment, now: number): boolean {
  const nextRetryAt = payment.nextRetryAt ? Date.parse(payment.nextRetryAt) : NaN

  return (
    payment.status === "paid_to_app" &&
    payment.settlementFailureState === "retryable" &&
    typeof payment.retryCount === "number" &&
    Number.isFinite(payment.retryCount) &&
    payment.retryCount > 0 &&
    Number.isFinite(nextRetryAt) &&
    nextRetryAt <= now &&
    !payment.a2uTxid &&
    payment.horizonSuccessFlag !== true &&
    !hasExcludedState(payment)
  )
}

function isPostHorizonEligible(payment: Payment, now: number): boolean {
  const nextRetryAt = payment.nextRetryAt === undefined ? now : typeof payment.nextRetryAt === "string" && payment.nextRetryAt !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() && Number.isFinite(Date.parse(payment.nextRetryAt)) ? Date.parse(payment.nextRetryAt) : NaN

  return (
    payment.status === "settlement_pending" &&
    Boolean(payment.a2uPaymentId) &&
    Boolean(payment.a2uTxid) &&
    payment.horizonSuccessFlag === true &&
    !hasExcludedState(payment) &&
    Number.isFinite(nextRetryAt) &&
    nextRetryAt <= now &&
    ((payment.piCompletionPending === true && payment.piCompleted !== true) ||
      (payment.piCompleted === true && payment.dbRecorded !== true))
  )
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  if (!isRedisConfigured) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 })
  }

  const drainLease = await acquireTransientDrainLease()
  if (drainLease.state === "unavailable") return NextResponse.json({ error: "Transient drain lease unavailable" }, { status: 503 })
  if (drainLease.state === "busy") {
    console.log("[P7J5 LEASE] overlap blocked")
    return NextResponse.json({ processed: 0, state: "overlap_blocked" })
  }

  console.log("[P7J5 LEASE] acquired")
  try {
  const initialPiCreateBackpressure = await readPiCreateBackpressure(Date.now())
  let piCreateBackpressureUnavailable = initialPiCreateBackpressure.state === "unavailable"
  let piCreateBackpressureUntilMs = initialPiCreateBackpressure.state === "active" ? initialPiCreateBackpressure.untilMs : null
  const piCreateBackpressureActive = () => piCreateBackpressureUnavailable || (piCreateBackpressureUntilMs !== null && piCreateBackpressureUntilMs > Date.now())
  const registerPiCreateBackpressure = async (payment: Payment) => {
    if (!isPiCreateBackpressureSignal(payment)) return false
    const observedAt = Date.now()
    const parsedRetryAt = typeof payment.nextRetryAt === "string" && payment.nextRetryAt.trim() !== "" && payment.nextRetryAt === payment.nextRetryAt.trim() ? Date.parse(payment.nextRetryAt) : NaN
    const localUntil = Math.max(observedAt + PI_CREATE_BACKPRESSURE_FALLBACK_MS, Number.isFinite(parsedRetryAt) && parsedRetryAt > observedAt ? parsedRetryAt : 0)
    piCreateBackpressureUntilMs = piCreateBackpressureUntilMs === null ? localUntil : Math.max(piCreateBackpressureUntilMs, localUntil)
    const extended = await extendPiCreateBackpressure(payment.nextRetryAt, observedAt)
    if (extended === null) {
      piCreateBackpressureUnavailable = true
    } else {
      piCreateBackpressureUntilMs = Math.max(piCreateBackpressureUntilMs, extended)
    }
    return true
  }
  const wakeStartedAt = Date.now()
  const discoveryStartedAt = Date.now()
  let keys: string[]
  let activeSetSize = 0
  let scanStartToken = "c:0"
  let scanNextToken = "c:0"
  try {
    const markers = await Promise.all([
      redis.get("flashpay:recovery:active-payments:v1:bootstrap"),
      redis.get("flashpay:recovery:active-payments:v1:prune-pending"),
      redis.get("flashpay:recovery:active-payments:v1:prune-final-settlement"),
    ])
    if (markers.some((marker) => marker !== "done")) return NextResponse.json({ error: "Active recovery index not ready" }, { status: 503 })

    const storedCursor = await redis.get("flashpay:recovery:active-payments:v1:scan-cursor")
    if (storedCursor !== null && (typeof storedCursor !== "string" || !/^c:[0-9]+$/.test(storedCursor))) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
    scanStartToken = storedCursor ?? "c:0"
    let pageCursor = scanStartToken.slice(2)
    const activePaymentIds: string[] = []
    const seenActivePaymentIds = new Set<string>()
    for (let page = 0; page < 4; page += 1) {
      const scanResult = await redis.sscan("flashpay:recovery:active-payments:v1", pageCursor, { count: 200 })
      if (!Array.isArray(scanResult) || scanResult.length !== 2) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      const [nextCursor, members] = scanResult
      if (typeof nextCursor !== "string" || !/^[0-9]+$/.test(nextCursor) || !Array.isArray(members)) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      for (const member of members) {
        if (typeof member !== "string" || member.length === 0 || member !== member.trim()) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
        if (!seenActivePaymentIds.has(member)) {
          seenActivePaymentIds.add(member)
          activePaymentIds.push(member)
        }
      }
      pageCursor = nextCursor
      scanNextToken = `c:${nextCursor}`
      if (nextCursor === "0") break
    }
    activeSetSize = Number(await redis.scard("flashpay:recovery:active-payments:v1"))
    keys = activePaymentIds.map((paymentId) => `payment:${paymentId}`)
  } catch {
    return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  }
  const readyResidencyIds: string[] = []
  let readyResidencyCount: number | null = null
  let readyResidencyMissing: number | null = null
  let readyResidencySourceValid = true
  const postHorizonIds: string[] = []
  const preparedSubmitIds: string[] = []
  const retryableIds: string[] = []
  const freshDispatchIds: string[] = []
  const settlementReconcilingDiscoveryIds: string[] = []
  const staleRetryReconcilingDiscoveryIds: string[] = []
  const refundCandidateIds: string[] = []
  const now = Date.now()

  for (let index = 0; index < keys.length; index += 200) {
    const batchKeys = keys.slice(index, index + 200)
    let values: unknown[]
    try {
      const batchValues = await redis.mget<unknown[]>(batchKeys)
      if (!Array.isArray(batchValues) || batchValues.length !== batchKeys.length) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
      values = batchValues
    } catch {
      return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
    }

    for (let valueIndex = 0; valueIndex < batchKeys.length; valueIndex += 1) {
      const key = batchKeys[valueIndex]
      const payment = parsePayment(values[valueIndex])
      if (!payment) {
        readyResidencySourceValid = false
        continue
      }

      const paymentId = key.slice("payment:".length)
      if (payment.id === paymentId && checkRefundEligibility(payment)) {
        refundCandidateIds.push(paymentId)
      }
      if (payment.id !== paymentId) {
        readyResidencySourceValid = false
        continue
      }
      if ((payment.status === "paid_to_app" || payment.status === "settlement_pending") && !hasExcludedState(payment)) readyResidencyIds.push(paymentId)
      if (isFreshSettlementDispatchCandidate(payment, now) || isStage1OnlySettlementDispatchCandidate(payment, now)) freshDispatchIds.push(paymentId)
      if (isStaleFreshReconcilingCandidate(payment, now)) settlementReconcilingDiscoveryIds.push(paymentId)
      if (isStaleRetryReconcilingCandidate(payment, now)) staleRetryReconcilingDiscoveryIds.push(paymentId)
      if (isPostHorizonEligible(payment, now)) {
        postHorizonIds.push(paymentId)
      } else if (isPreparedSubmitEligible(payment)) {
        preparedSubmitIds.push(paymentId)
      } else if (isEligible(payment, now)) {
        retryableIds.push(paymentId)
      }
    }
  }
  const readyCoverageAllIds = [...new Set([...postHorizonIds, ...preparedSubmitIds, ...retryableIds, ...freshDispatchIds, ...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])]
  const readyCoverageTruncated = readyCoverageAllIds.length > 800
  let readyCoverageIndexed: number | null = null
  let readyCoverageMissing: number | null = null
  if (readyCoverageTruncated) {
    console.warn("[P7H CAPACITY] settlement ready coverage truncated")
  } else {
    try {
      let indexed = 0
      let missing = 0
      for (let batchStart = 0; batchStart < readyCoverageAllIds.length; batchStart += 200) {
        const batch = readyCoverageAllIds.slice(batchStart, batchStart + 200)
        const scores = await redis.zmscore("flashpay:settlement:ready:v1", batch)
        if (!Array.isArray(scores) || scores.length !== batch.length || scores.some((score) => score !== null && (typeof score !== "number" || !Number.isSafeInteger(score) || score < 0))) throw new Error("Invalid settlement ready coverage")
        indexed += scores.filter((score) => score !== null).length
        missing += scores.filter((score) => score === null).length
      }
      readyCoverageIndexed = indexed
      readyCoverageMissing = missing
    } catch {
      console.warn("[P7H CAPACITY] settlement ready coverage unavailable")
    }
  }
  let readyHeadTruncated: boolean | null = null
  let readyCoverageOutsideHead: number | null = null
  const readySample = freshDispatchIds.slice(0, 200)
  let readySetSize: number | null = null
  let readyIndexed: number | null = null
  let readyMissing: number | null = null
  try {
    const indexedSetSize = await redis.zcard("flashpay:settlement:ready:v1")
    if (typeof indexedSetSize !== "number" || !Number.isSafeInteger(indexedSetSize) || indexedSetSize < 0) throw new Error("Invalid settlement ready set size")
    readySetSize = indexedSetSize
    if (readySample.length === 0) {
      readyIndexed = 0
      readyMissing = 0
    } else {
      const readyScores = await redis.zmscore("flashpay:settlement:ready:v1", readySample)
      if (!Array.isArray(readyScores) || readyScores.length !== readySample.length || readyScores.some((score) => score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0))) throw new Error("Invalid settlement ready scores")
      readyIndexed = readyScores.filter((score) => score !== null).length
      readyMissing = readyScores.filter((score) => score === null).length
    }
  } catch {
    console.warn("[P7H CAPACITY] settlement ready telemetry unavailable")
  }
  let readyOrderedCount: number | null = null
  let readyFirstScore: number | null = null
  let readyLastScore: number | null = null
  let readyStrictlyIncreasing: boolean | null = null
  let readyOrderedValid = false
  const readyOrderedIds: string[] = []
  let readyRotationStart: string | null = null
  let readyRotationNext: string | null = null
  let readyRotationCas: number | null = null
  let readyRotationCycleMax: number | null = null
  let readyRotationCycleGeneration: number | null = null
  try {
    const storedRotation = await redis.get<unknown>("flashpay:settlement:ready:v1:authority-cursor")
    if (storedRotation !== null && typeof storedRotation !== "string") throw new Error("Invalid settlement ready authority cursor")
    const rotationStart = storedRotation ?? "r:0"
    if (!/^r:[0-9]+$/.test(rotationStart)) throw new Error("Invalid settlement ready authority cursor")
    const rotationScore = Number(rotationStart.slice(2))
    if (!Number.isSafeInteger(rotationScore) || rotationScore < 0 || rotationScore >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid settlement ready authority cursor")
    const cycleStateResult = await redis.eval<[string], string>("local max=redis.call('GET',KEYS[1]); local generation=redis.call('GET',KEYS[2]); if max then local value=tonumber(max); if not value or value < 0 or value >= 9007199254740990 or value ~= math.floor(value) then return '-1' end; if generation then local gen=tonumber(generation); if not gen or gen < 0 or gen >= 9007199254740990 or gen ~= math.floor(gen) then return '-1' end else redis.call('SET',KEYS[2],'1'); generation='1' end; return max..':'..generation end; if ARGV[1] ~= 'r:0' then return '-1' end; local gen=0; if generation then gen=tonumber(generation); if not gen or gen < 0 or gen >= 9007199254740990 or gen ~= math.floor(gen) then return '-1' end end; if gen >= 9007199254740989 then return '-1' end; gen=gen+1; local top=redis.call('ZRANGE',KEYS[3],-1,-1,'WITHSCORES'); if #top ~= 0 and #top ~= 2 then return '-1' end; local base=0; if #top == 2 then local score=tonumber(top[2]); if not score or score < 0 or score >= 9007199254740990 or score ~= math.floor(score) then return '-1' end; base=score end; if base > 9007199254740990 then return '-1' end; redis.call('SET',KEYS[2],gen); redis.call('SET',KEYS[1],base); return tostring(base)..':'..tostring(gen)", ["flashpay:settlement:ready:v1:authority-cycle-max", "flashpay:settlement:ready:v1:authority-cycle-generation", "flashpay:settlement:ready:v1"], [rotationStart])
    const cycleParts = cycleStateResult.split(":")
    if (cycleParts.length !== 2 || !/^[0-9]+$/.test(cycleParts[0]) || !/^[0-9]+$/.test(cycleParts[1])) throw new Error("Invalid settlement ready authority cycle state")
    const cycleMax = Number(cycleParts[0])
    const cycleGeneration = Number(cycleParts[1])
    if (!Number.isSafeInteger(cycleMax) || cycleMax < 0 || cycleMax >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(cycleGeneration) || cycleGeneration < 0 || cycleGeneration >= Number.MAX_SAFE_INTEGER || (rotationScore !== 0 && cycleMax < rotationScore)) throw new Error("Invalid settlement ready authority cycle state")
    readyRotationCycleMax = cycleMax
    readyRotationCycleGeneration = cycleGeneration
    const orderedIds: string[] = []
    let firstScore: number | null = null
    let strictlyIncreasing = true
    let previousScore: number | null = null
    let pageStartScore = rotationScore === 0 ? 0 : rotationScore + 1
    let headTruncated = false
    let rotationEnded = false
    for (let page = 0; page < 4; page += 1) {
      const readyOrdered = await redis.zrange("flashpay:settlement:ready:v1", pageStartScore, cycleMax, { byScore: true, withScores: true, offset: 0, count: 201 })
      if (!Array.isArray(readyOrdered) || readyOrdered.length > 402 || readyOrdered.length % 2 !== 0) throw new Error("Invalid ordered settlement ready telemetry")
      const pairCount = readyOrdered.length / 2
      if (page === 3 && pairCount === 201) headTruncated = true
      for (let index = 0; index < readyOrdered.length; index += 2) {
        const member = readyOrdered[index]
        const score = readyOrdered[index + 1]
        if (typeof member !== "string" || member.length === 0 || member !== member.trim() || typeof score !== "number" || !Number.isSafeInteger(score) || score < 1 || score < pageStartScore) throw new Error("Invalid ordered settlement ready telemetry")
        if (previousScore !== null && score <= previousScore) throw new Error("Invalid ordered settlement ready telemetry")
        if (index / 2 < 200) {
          orderedIds.push(member)
          if (firstScore === null) firstScore = score
          previousScore = score
        } else if (pairCount < 201 || previousScore === null || score <= previousScore) {
          throw new Error("Invalid ordered settlement ready telemetry")
        }
      }
      rotationEnded = pairCount <= 200
      if (rotationEnded) break
      if (previousScore === null || previousScore >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid ordered settlement ready telemetry")
      pageStartScore = previousScore + 1
    }
    if (orderedIds.length > 800) throw new Error("Invalid ordered settlement ready telemetry")
    readyOrderedIds.push(...orderedIds)
    readyOrderedCount = orderedIds.length
    readyFirstScore = firstScore
    readyLastScore = previousScore
    readyStrictlyIncreasing = strictlyIncreasing
    readyHeadTruncated = headTruncated
    readyRotationStart = rotationStart
    readyRotationNext = rotationEnded ? "r:0" : `r:${previousScore}`
    readyOrderedValid = true
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready telemetry unavailable")
  }

  if (readyOrderedValid === true && readyCoverageTruncated === false && readyCoverageMissing === 0) {
    const readyHeadIds = new Set(readyOrderedIds)
    readyCoverageOutsideHead = readyCoverageAllIds.filter((id) => !readyHeadIds.has(id)).length
  }

  let readyClassInvalid: number | null = null
  let readyClassPostHorizon: number | null = null
  let readyClassPrepared: number | null = null
  let readyClassRetryable: number | null = null
  let readyClassFresh: number | null = null
  let readyClassStage1Only: number | null = null
  let readyClassReconciling: number | null = null
  let readyClassOther: number | null = null
  let readyShadowEligibleIds: string[] | null = null
  let readyShadowPreparedIds: string[] | null = null
  let readyShadowFreshIds: string[] | null = null
  let readyShadowFreshCreateIds: string[] | null = null
  let readyShadowStage1OnlyIds: string[] | null = null
  let readyShadowReconcilingIds: string[] | null = null
  let walletDrainShadowCount: number | null = null
  let walletDrainShadowHeadPaymentId: string | null = null
  let walletDrainShadowHeadRefundId: string | null = null
  let walletDrainShadowHeadKind: "settlement" | "refund" | null = null
  let walletDrainSelectedHeadKind: "settlement" | "refund" | null = null
  let walletDrainSelectedHeadPaymentId: string | null = null
  let walletDrainSelectedHeadRefundId: string | null = null
  let walletDrainSelectedHeadParity: boolean | null = null
  let walletDrainNonEmptyParity: boolean | null = null
  let walletDrainNonMoneyCertification = false
  let walletDrainPreExecutionHeadKind: "settlement" | "refund" | null = null
  let walletDrainPreExecutionHeadPaymentId: string | null = null
  let walletDrainPreExecutionHeadRefundId: string | null = null
  let readyEligibleSetParity: boolean | null = null
  let readyFreshSetParity: boolean | null = null
  let readyReconcilingSetParity: boolean | null = null
  try {
    let classInvalid = 0
    const shadowPostHorizonIds: string[] = []
    const shadowPreparedIds: string[] = []
    const shadowRetryableIds: string[] = []
    const shadowFreshDispatchIds: string[] = []
    const shadowFreshCreateIds: string[] = []
    const shadowStage1OnlyIds: string[] = []
    const shadowReconcilingIds: string[] = []
    let classPostHorizon = 0
    let classPrepared = 0
    let classRetryable = 0
    let classFresh = 0
    let classStage1Only = 0
    let classReconciling = 0
    let classOther = 0
    if (!readyOrderedValid) {
      throw new Error("Ordered settlement ready telemetry unavailable")
    }
    if (readyOrderedIds.length > 0) {
      for (let batchStart = 0; batchStart < readyOrderedIds.length; batchStart += 200) {
        const batchIds = readyOrderedIds.slice(batchStart, batchStart + 200)
        const readyValues = await redis.mget<unknown[]>(batchIds.map((id) => `payment:${id}`))
        if (!Array.isArray(readyValues) || readyValues.length !== batchIds.length) throw new Error("Invalid ordered settlement ready payment telemetry")
        for (let index = 0; index < batchIds.length; index += 1) {
          const payment = parsePayment(readyValues[index])
          const paymentId = batchIds[index]
          if (!payment || payment.id !== paymentId) {
            classInvalid++
          } else if (isPostHorizonEligible(payment, now)) {
          classPostHorizon++
          shadowPostHorizonIds.push(paymentId)
        } else if (isPreparedSubmitEligible(payment)) {
          classPrepared++
          shadowPreparedIds.push(paymentId)
        } else if (isEligible(payment, now)) {
          classRetryable++
          shadowRetryableIds.push(paymentId)
        } else if (isFreshSettlementDispatchCandidate(payment, now)) {
          classFresh++
          shadowFreshDispatchIds.push(paymentId)
          shadowFreshCreateIds.push(paymentId)
        } else if (isStage1OnlySettlementDispatchCandidate(payment, now)) {
          classStage1Only++
          shadowFreshDispatchIds.push(paymentId)
          shadowStage1OnlyIds.push(paymentId)
        } else if (isStaleFreshReconcilingCandidate(payment, now) || isStaleRetryReconcilingCandidate(payment, now)) {
          classReconciling++
          shadowReconcilingIds.push(paymentId)
        } else {
          classOther++
        }
      }
    }
    }
    if (readyHeadTruncated === false && readyCoverageTruncated === false && readyCoverageMissing === 0 && readyCoverageOutsideHead === 0 && classInvalid === 0) {
      const eligibleSet = new Set([...postHorizonIds, ...preparedSubmitIds, ...retryableIds])
      const shadowEligibleSet = new Set([...shadowPostHorizonIds, ...shadowPreparedIds, ...shadowRetryableIds])
      readyEligibleSetParity = eligibleSet.size === shadowEligibleSet.size && [...eligibleSet].every((id) => shadowEligibleSet.has(id))
      const freshSet = new Set(freshDispatchIds)
      const shadowFreshSet = new Set(shadowFreshDispatchIds)
      readyFreshSetParity = freshSet.size === shadowFreshSet.size && [...freshSet].every((id) => shadowFreshSet.has(id))
      const reconcilingSet = new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])
      const shadowReconcilingSet = new Set(shadowReconcilingIds)
      readyReconcilingSetParity = reconcilingSet.size === shadowReconcilingSet.size && [...reconcilingSet].every((id) => shadowReconcilingSet.has(id))
    }
    readyClassInvalid = classInvalid
    readyClassPostHorizon = classPostHorizon
    readyClassPrepared = classPrepared
    readyClassRetryable = classRetryable
    readyClassFresh = classFresh
    readyClassStage1Only = classStage1Only
    readyClassReconciling = classReconciling
    readyClassOther = classOther
    readyShadowEligibleIds = [...shadowPostHorizonIds, ...shadowPreparedIds, ...shadowRetryableIds].slice(0, MAX_ATTEMPTS)
    readyShadowPreparedIds = classInvalid === 0 ? shadowPreparedIds : null
    readyShadowFreshIds = shadowFreshDispatchIds.slice(0, MAX_ATTEMPTS)
    const readyFreshWindow = new Set(readyShadowFreshIds)
    readyShadowFreshCreateIds = classInvalid === 0 ? shadowFreshCreateIds.filter((id) => readyFreshWindow.has(id)) : null
    readyShadowStage1OnlyIds = classInvalid === 0 ? shadowStage1OnlyIds.filter((id) => readyFreshWindow.has(id)) : null
    readyShadowReconcilingIds = shadowReconcilingIds.slice(0, 1)
    if (classInvalid === 0) walletDrainShadowCount = classPrepared + classFresh + classStage1Only + classReconciling
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready classification unavailable")
  }

  if (readyOrderedValid === true && readyClassInvalid === 0 && readyShadowEligibleIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null && readyRotationStart !== null && readyRotationNext !== null && readyRotationCycleMax !== null && readyRotationCycleGeneration !== null) {
    try {
      const rotationCas = await redis.eval<[string, string, string, string], number>("local current=redis.call('GET',KEYS[1]); if not current then current='r:0' end; local cycle=redis.call('GET',KEYS[2]); local generation=redis.call('GET',KEYS[3]); if current==ARGV[1] and cycle==ARGV[3] and generation==ARGV[4] then if ARGV[2]=='r:0' then redis.call('SET',KEYS[1],ARGV[2]); redis.call('DEL',KEYS[2]); return 1 end; return redis.call('SET',KEYS[1],ARGV[2]) and 1 or 0 end; return 0", ["flashpay:settlement:ready:v1:authority-cursor", "flashpay:settlement:ready:v1:authority-cycle-max", "flashpay:settlement:ready:v1:authority-cycle-generation"], [readyRotationStart, readyRotationNext, String(readyRotationCycleMax), String(readyRotationCycleGeneration)])
      if (rotationCas !== 0 && rotationCas !== 1) throw new Error("Invalid settlement ready authority cursor CAS")
      readyRotationCas = rotationCas
    } catch {
      console.warn("[P7H CAPACITY] settlement ready authority cursor unavailable")
    }
  }

  let readyResidencyBackfilled: number | null = null
  if (readyResidencySourceValid === true) {
    try {
      let missing = 0
      const missingIds: string[] = []
      for (let batchStart = 0; batchStart < readyResidencyIds.length; batchStart += 200) {
        const batch = readyResidencyIds.slice(batchStart, batchStart + 200)
        const scores = await redis.zmscore("flashpay:settlement:ready:v1", batch)
        if (!Array.isArray(scores) || scores.length !== batch.length || scores.some((score) => score !== null && (typeof score !== "number" || !Number.isSafeInteger(score) || score < 1))) throw new Error("Invalid settlement ready residency telemetry")
        scores.forEach((score, index) => { if (score === null) missingIds.push(batch[index]) })
        missing += scores.filter((score) => score === null).length
      }
      readyResidencyCount = readyResidencyIds.length
      readyResidencyMissing = missing
      if (missingIds.length === 0) {
        readyResidencyBackfilled = 0
      } else {
        const backfilled = await redis.eval<string[], number>("local top=redis.call('ZRANGE',KEYS[1],-1,-1,'WITHSCORES'); if #top ~= 0 and #top ~= 2 then return -1 end; local topScore=0; if #top == 2 then topScore=tonumber(top[2]); if not topScore or topScore < 1 or topScore > 9007199254740990 or topScore ~= math.floor(topScore) then return -1 end end; local seq=redis.call('GET',KEYS[2]); local base=topScore; if seq then base=tonumber(seq); if not base or base < 0 or base > 9007199254740990 or base ~= math.floor(base) or base < topScore then return -1 end end; if base + #ARGV > 9007199254740990 then return -1 end; if not seq then redis.call('SET',KEYS[2],base) end; local added=0; for _,id in ipairs(ARGV) do if redis.call('SISMEMBER',KEYS[3],id)==1 and not redis.call('ZSCORE',KEYS[1],id) then local next=redis.call('INCR',KEYS[2]); redis.call('ZADD',KEYS[1],'NX',next,id); added=added+1 end end; return added", ["flashpay:settlement:ready:v1", "flashpay:settlement:ready:v1:sequence", "flashpay:recovery:active-payments:v1"], missingIds)
        if (!Number.isSafeInteger(backfilled) || backfilled < 0 || backfilled > missingIds.length) throw new Error("Invalid settlement ready residency backfill")
        readyResidencyBackfilled = backfilled
      }
    } catch {
      console.warn("[P7H CAPACITY] settlement ready residency telemetry unavailable")
    }
  }


  const discoveryDurationMs = Date.now() - discoveryStartedAt

  const readyAuthorityCertified = readyResidencySourceValid === true && scanNextToken === "c:0" && Number.isSafeInteger(activeSetSize) && activeSetSize >= 0 && keys.length === activeSetSize && readyResidencyMissing === 0 && readyResidencyBackfilled === 0
  const readySchedulerUsable = readyAuthorityCertified && readyRotationStart === "r:0" && readyStrictlyIncreasing === true && readyClassInvalid === 0 && readyEligibleSetParity === true && readyFreshSetParity === true && readyReconcilingSetParity === true && readyShadowEligibleIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null
  let readyBaselineCertified: boolean | null = null
  try {
    const baselineResult = await redis.eval<[string], number>("local current=redis.call('GET',KEYS[1]); if current=='done' then return 1 end; if current then return -1 end; if ARGV[1]=='1' then redis.call('SET',KEYS[1],'done'); return 1 end; return 0", ["flashpay:settlement:ready:v1:authority-baseline"], [readySchedulerUsable ? "1" : "0"])
    if (baselineResult !== -1 && baselineResult !== 0 && baselineResult !== 1) throw new Error("Invalid settlement ready authority baseline")
    if (baselineResult === -1) {
      console.warn("[P7H CAPACITY] settlement ready authority baseline mismatch")
    } else {
      readyBaselineCertified = baselineResult === 1
    }
  } catch {
    console.warn("[P7H CAPACITY] settlement ready authority baseline unavailable")
  }
  const readyWindowCertified = readyBaselineCertified === true && readyRotationCas === 1 && readyOrderedValid === true && readyStrictlyIncreasing === true && readyClassInvalid === 0 && readyResidencySourceValid === true && readyResidencyMissing === 0 && readyResidencyBackfilled === 0 && readyShadowEligibleIds !== null && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null && readyShadowReconcilingIds !== null
  const useReadyExecution = readyWindowCertified === true
  const eligibleIds = readyShadowEligibleIds !== null && useReadyExecution ? readyShadowEligibleIds : [...postHorizonIds, ...preparedSubmitIds, ...retryableIds].slice(0, MAX_ATTEMPTS)
  const freshExecutionIds = readyShadowFreshIds !== null && useReadyExecution ? readyShadowFreshIds : freshDispatchIds.slice(0, MAX_ATTEMPTS)
  const settlementReconcilingExecutionIds = readyShadowReconcilingIds !== null && useReadyExecution ? readyShadowReconcilingIds : [...new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])].slice(0, 1)
  const retryableIdSet = new Set(retryableIds)
  const walletDrainFairnessClass = useReadyExecution ? walletDrainFairnessClassForGeneration(readyRotationCycleGeneration) : null
  const walletFreshExecutionIds = useReadyExecution && readyShadowFreshIds !== null && readyShadowFreshCreateIds !== null && readyShadowStage1OnlyIds !== null
    ? (piCreateBackpressureActive() ? readyShadowStage1OnlyIds : readyShadowFreshIds)
    : freshExecutionIds

  const selectWalletDrainHead = (preparedIds: string[], eligibleIds: string[], freshIds: string[], reconcilingIds: string[], refundPaymentId: string | null, refundId: string | null, fairnessClass: WalletDrainFairnessClass | null): { kind: "settlement" | "refund" | null; paymentId: string | null; refundId: string | null; lane: WalletDrainLane | null } => {
    const preparedHead = eligibleIds.find((id) => preparedIds.includes(id))
    if (preparedHead !== undefined) return { kind: "settlement", paymentId: preparedHead, refundId: null, lane: "prepared" }
    if (fairnessClass === null) return { kind: null, paymentId: null, refundId: null, lane: null }

    const candidates: Record<WalletDrainFairnessClass, { kind: "settlement" | "refund"; paymentId: string; refundId: string | null } | null> = {
      fresh: freshIds[0] !== undefined ? { kind: "settlement", paymentId: freshIds[0], refundId: null } : null,
      reconciling: reconcilingIds[0] !== undefined ? { kind: "settlement", paymentId: reconcilingIds[0], refundId: null } : null,
      refund: refundPaymentId !== null && refundId !== null ? { kind: "refund", paymentId: refundPaymentId, refundId } : null,
    }
    const startIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(fairnessClass)
    for (let offset = 0; offset < WALLET_DRAIN_FAIRNESS_ORDER.length; offset += 1) {
      const lane = WALLET_DRAIN_FAIRNESS_ORDER[(startIndex + offset) % WALLET_DRAIN_FAIRNESS_ORDER.length]
      const candidate = candidates[lane]
      if (candidate !== null) return { ...candidate, lane }
    }
    return { kind: null, paymentId: null, refundId: null, lane: null }
  }

  const preRefundDrain = await readAutomaticRefundDrainHead(MAX_ATTEMPTS)
  if (preRefundDrain.state === "ok") {
    const preTelemetryHead = selectWalletDrainHead(useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, preRefundDrain.refundDrainHeadPaymentId, preRefundDrain.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainPreExecutionHeadKind = preTelemetryHead.kind
    walletDrainPreExecutionHeadPaymentId = preTelemetryHead.paymentId
    walletDrainPreExecutionHeadRefundId = preTelemetryHead.refundId
  }

  let preHead: ReturnType<typeof selectWalletDrainHead> | null = null
  if (useReadyExecution && readyShadowPreparedIds !== null && preRefundDrain.state === "ok") {
    preHead = selectWalletDrainHead(readyShadowPreparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, preRefundDrain.refundDrainHeadPaymentId, preRefundDrain.refundDrainHeadRefundId, walletDrainFairnessClass)
  }
  console.log("[transient-wake] scheduler wallet authority", { ready: preHead !== null, schedulerWalletPaymentId: preHead?.kind === "settlement" ? preHead.paymentId : null, refundPaymentId: preHead?.kind === "refund" ? preHead.paymentId : null, refundId: preHead?.kind === "refund" ? preHead.refundId : null })

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before work")

  const workStartedAt = Date.now()
  const results: Array<{ paymentId: string; ok: boolean; status?: string; error?: string }> = []
  const preparedExecutionIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
  const preparedExecutionSet = new Set(useReadyExecution ? preparedExecutionIds : [])

  const eligiblePipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(eligibleIds.filter((paymentId) => !preparedExecutionSet.has(paymentId)), async (paymentId) => {
    if (retryableIdSet.has(paymentId) && piCreateBackpressureActive()) return { value: { paymentId, ok: false, error: "pi_create_backpressure" } }
    const result = await executeA2URecovery(paymentId, null)
    const latest = parsePayment(await redis.get(`payment:${paymentId}`))
    const backpressureTriggered = retryableIdSet.has(paymentId) && latest !== null ? await registerPiCreateBackpressure(latest) : false
    return {
      value: { paymentId, ok: result.status === "success" || result.status === "db_reconciled", status: latest?.status, error: result.details?.error },
      stop: backpressureTriggered,
    }
  })
  results.push(...eligiblePipeline.values)

  let refundAccountingReady: boolean | null = null
  const walletDrainAttemptedSettlementIds = new Set<string>()
  const walletDrainAttemptedRefundIds = new Set<string>()
  const walletDrainBurstLanes: WalletDrainLane[] = []
  let walletDrainBurstSettlementAttempts = 0
  let walletDrainBurstRefundAttempts = 0
  let walletDrainBurstStopReason: string | null = null
  let walletDrainFairnessOffset = 0
  let currentRefundDrain = preRefundDrain
  const walletDrainBurstStartedAt = Date.now()

  if (useReadyExecution && readyShadowPreparedIds !== null && readyShadowFreshIds !== null && readyShadowStage1OnlyIds !== null && walletDrainFairnessClass !== null && currentRefundDrain.state === "ok") {
    const fairnessStartIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(walletDrainFairnessClass)
    for (let attempt = 0; attempt < WALLET_DRAIN_BURST_LIMIT; attempt += 1) {
      if (Date.now() - walletDrainBurstStartedAt >= WALLET_DRAIN_BURST_BUDGET_MS) break
      if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
      if (currentRefundDrain.state !== "ok") break

      const attemptFairnessClass = WALLET_DRAIN_FAIRNESS_ORDER[(fairnessStartIndex + walletDrainFairnessOffset) % WALLET_DRAIN_FAIRNESS_ORDER.length]
      const attemptFreshIds = (piCreateBackpressureActive() && readyShadowStage1OnlyIds !== null ? readyShadowStage1OnlyIds : readyShadowFreshIds).filter((id) => !walletDrainAttemptedSettlementIds.has(id))
      const attemptHead = selectWalletDrainHead(
        readyShadowPreparedIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        eligibleIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        attemptFreshIds,
        settlementReconcilingExecutionIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)),
        currentRefundDrain.refundDrainHeadPaymentId !== null && currentRefundDrain.refundDrainHeadRefundId !== null && !walletDrainAttemptedRefundIds.has(currentRefundDrain.refundDrainHeadRefundId) ? currentRefundDrain.refundDrainHeadPaymentId : null,
        currentRefundDrain.refundDrainHeadPaymentId !== null && currentRefundDrain.refundDrainHeadRefundId !== null && !walletDrainAttemptedRefundIds.has(currentRefundDrain.refundDrainHeadRefundId) ? currentRefundDrain.refundDrainHeadRefundId : null,
        attemptFairnessClass,
      )
      if (attemptHead.kind === null || attemptHead.lane === null) break
      walletDrainBurstLanes.push(attemptHead.lane)

      if (attemptHead.kind === "settlement" && attemptHead.paymentId !== null) {
        walletDrainAttemptedSettlementIds.add(attemptHead.paymentId)
        walletDrainBurstSettlementAttempts += 1
        const selectedWasFreshCreate = readyShadowFreshCreateIds?.includes(attemptHead.paymentId) === true
        const result = await executeA2URecovery(attemptHead.paymentId, attemptHead.paymentId)
        const latest = parsePayment(await redis.get(`payment:${attemptHead.paymentId}`))
        if (selectedWasFreshCreate && latest !== null) await registerPiCreateBackpressure(latest)
        const value: RecoveryPipelineValue = { paymentId: attemptHead.paymentId, ok: result.status === "success" || result.status === "db_reconciled", status: latest?.status, error: result.details?.error }
        const existingIndex = results.findIndex((item) => item.paymentId === attemptHead.paymentId)
        if (existingIndex >= 0) results[existingIndex] = value
        else results.push(value)
        const settlementSafeToContinue = result.status === "success" || result.status === "db_reconciled"
        if (!settlementSafeToContinue) {
          walletDrainBurstStopReason = `settlement_${result.state}`
          break
        }
      } else if (attemptHead.kind === "refund" && attemptHead.paymentId !== null && attemptHead.refundId !== null) {
        if (refundAccountingReady === null) refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
        if (!refundAccountingReady) break
        walletDrainAttemptedRefundIds.add(attemptHead.refundId)
        walletDrainBurstRefundAttempts += 1
        let authorizedRefundPass: Awaited<ReturnType<typeof runAutomaticRefundPass>>
        try {
          authorizedRefundPass = await runAutomaticRefundPass(MAX_ATTEMPTS, { paymentId: attemptHead.paymentId, refundId: attemptHead.refundId })
        } catch {
          authorizedRefundPass = { state: "blocked" }
        }
        if (authorizedRefundPass.state !== "ok") {
          walletDrainBurstStopReason = "refund_pass_blocked"
          break
        }
        const authorizedRefundResult = authorizedRefundPass.results.find((item) => item.refundId === attemptHead.refundId && item.paymentId === attemptHead.paymentId && item.action === "execute")
        if (authorizedRefundResult?.outcome !== "success") {
          walletDrainBurstStopReason = `refund_${authorizedRefundResult?.reason ?? authorizedRefundResult?.outcome ?? "unresolved"}`
          break
        }
        currentRefundDrain = await readAutomaticRefundDrainHead(MAX_ATTEMPTS)
        if (currentRefundDrain.state !== "ok") {
          walletDrainBurstStopReason = "refund_head_unavailable"
          break
        }
      }

      if (attemptHead.lane !== "prepared") {
        const selectedFairnessIndex = WALLET_DRAIN_FAIRNESS_ORDER.indexOf(attemptHead.lane)
        walletDrainFairnessOffset = (selectedFairnessIndex - fairnessStartIndex + 1 + WALLET_DRAIN_FAIRNESS_ORDER.length) % WALLET_DRAIN_FAIRNESS_ORDER.length
      }
    }
  }
  const walletDrainBurstDurationMs = Date.now() - walletDrainBurstStartedAt

  const freshPipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(freshExecutionIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)), async (id) => {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (payment?.id !== id) return {}
    const handlerNow = Date.now()
    const freshCreate = isFreshSettlementDispatchCandidate(payment, handlerNow)
    const stage1Only = isStage1OnlySettlementDispatchCandidate(payment, handlerNow)
    if (!freshCreate && !stage1Only) return {}
    if (freshCreate && piCreateBackpressureActive()) return { value: { paymentId: id, ok: false, status: payment.status, error: "pi_create_backpressure" } }
    const result = await executeA2URecovery(id, null)
    const latest = parsePayment(await redis.get(`payment:${id}`))
    const backpressureTriggered = freshCreate && latest !== null ? await registerPiCreateBackpressure(latest) : false
    return {
      value: { paymentId: id, ok: result.status === "success", status: latest?.status, error: result.details?.error },
      stop: backpressureTriggered,
    }
  })
  results.push(...freshPipeline.values)

  const reconcilingPipeline = await runBoundedOrderedPipeline<RecoveryPipelineValue>(settlementReconcilingExecutionIds.filter((id) => !walletDrainAttemptedSettlementIds.has(id)), async (id) => {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (payment?.id !== id || (!isStaleFreshReconcilingCandidate(payment, Date.now()) && !isStaleRetryReconcilingCandidate(payment, Date.now()))) return {}
    const result = await executeA2URecovery(id, null)
    const latest = parsePayment(await redis.get(`payment:${id}`))
    return { value: { paymentId: id, ok: result.status === "success", status: latest?.status, error: result.details?.error } }
  })
  results.push(...reconcilingPipeline.values)
  const settlementPipelinePeakInFlight = Math.max(eligiblePipeline.peakInFlight, freshPipeline.peakInFlight, reconcilingPipeline.peakInFlight)

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before refund drain")

  let refundPass: Awaited<ReturnType<typeof runAutomaticRefundPass>>
  const refundResults = []
  let refundIntakePeakInFlight = 0
  if (refundAccountingReady === null) refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
  if (refundAccountingReady) {
    try {
      refundPass = await runAutomaticRefundPass(MAX_ATTEMPTS, null)
    } catch {
      refundPass = { state: "blocked" }
    }

    const refundIntakePipeline = await runBoundedOrderedPipeline(refundCandidateIds.slice(0, MAX_ATTEMPTS), async (paymentId) => {
      try {
        return { value: await ensureAutomaticRefundIntent(paymentId) }
      } catch {
        return { value: { outcome: "blocked" as const, paymentId, reason: "intake_exception" } }
      }
    })
    refundResults.push(...refundIntakePipeline.values)
    refundIntakePeakInFlight = refundIntakePipeline.peakInFlight
  } else {
    refundPass = { state: "blocked" }
  }

  if (walletDrainShadowCount !== null && refundPass.state === "ok" && (!useReadyExecution || readyShadowPreparedIds !== null)) {
    walletDrainShadowCount += refundPass.refundDrainCount
    const preparedIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
    const shadowHead = selectWalletDrainHead(preparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, refundPass.refundDrainHeadPaymentId, refundPass.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainShadowHeadPaymentId = shadowHead.paymentId
    walletDrainShadowHeadRefundId = shadowHead.refundId
    walletDrainShadowHeadKind = shadowHead.kind
  } else {
    walletDrainShadowCount = null
    walletDrainShadowHeadPaymentId = null
    walletDrainShadowHeadRefundId = null
    walletDrainShadowHeadKind = null
  }

  if (walletDrainShadowCount !== null && refundPass.state === "ok" && (!useReadyExecution || readyShadowPreparedIds !== null)) {
    const preparedIds = useReadyExecution && readyShadowPreparedIds !== null ? readyShadowPreparedIds : preparedSubmitIds
    const selectedHead = selectWalletDrainHead(preparedIds, eligibleIds, walletFreshExecutionIds, settlementReconcilingExecutionIds, refundPass.refundDrainHeadPaymentId, refundPass.refundDrainHeadRefundId, walletDrainFairnessClass)
    walletDrainSelectedHeadKind = selectedHead.kind
    walletDrainSelectedHeadPaymentId = selectedHead.paymentId
    walletDrainSelectedHeadRefundId = selectedHead.refundId
    walletDrainSelectedHeadParity = selectedHead.kind === walletDrainShadowHeadKind && selectedHead.paymentId === walletDrainShadowHeadPaymentId && selectedHead.refundId === walletDrainShadowHeadRefundId
  } else {
    walletDrainSelectedHeadKind = null
    walletDrainSelectedHeadPaymentId = null
    walletDrainSelectedHeadRefundId = null
    walletDrainSelectedHeadParity = null
  }

  const shadowHeadValid = (walletDrainShadowHeadKind === "settlement" && walletDrainShadowHeadPaymentId !== null && walletDrainShadowHeadRefundId === null) || (walletDrainShadowHeadKind === "refund" && walletDrainShadowHeadPaymentId !== null && walletDrainShadowHeadRefundId !== null)
  const selectedHeadValid = (walletDrainSelectedHeadKind === "settlement" && walletDrainSelectedHeadPaymentId !== null && walletDrainSelectedHeadRefundId === null) || (walletDrainSelectedHeadKind === "refund" && walletDrainSelectedHeadPaymentId !== null && walletDrainSelectedHeadRefundId !== null)
  if (walletDrainShadowCount !== null && walletDrainShadowCount > 0 && walletDrainSelectedHeadParity !== null && shadowHeadValid && selectedHeadValid) walletDrainNonEmptyParity = walletDrainSelectedHeadParity
  const certificationA = selectWalletDrainHead(["p"], ["p"], ["f"], ["q"], "rp", "r", "refund")
  const certificationB = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "fresh")
  const certificationC = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "reconciling")
  const certificationD = selectWalletDrainHead([], [], ["f"], ["q"], "rp", "r", "refund")
  const certificationE = selectWalletDrainHead([], [], ["f"], [], null, null, "refund")
  walletDrainNonMoneyCertification = certificationA.lane === "prepared" && certificationA.paymentId === "p" && certificationB.lane === "fresh" && certificationB.paymentId === "f" && certificationC.lane === "reconciling" && certificationC.paymentId === "q" && certificationD.lane === "refund" && certificationD.paymentId === "rp" && certificationD.refundId === "r" && certificationE.lane === "fresh" && certificationE.paymentId === "f"

  const settlementReconcilingEvidence = { FOUND: 0, CONFIRMED_NONE: 0, INDETERMINATE: 0, skipped: 0 }
  const settlementReconcilingEvidenceIds = [...new Set([...settlementReconcilingDiscoveryIds, ...staleRetryReconcilingDiscoveryIds])].slice(0, 1)
  for (const id of settlementReconcilingEvidenceIds) {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (!payment || payment.id !== id || (!isStaleFreshReconcilingCandidate(payment, Date.now()) && !isStaleRetryReconcilingCandidate(payment, Date.now()))) {
      settlementReconcilingEvidence.skipped++
      continue
    }
    const customerAmount = payment.customerAmount
    const merchantUid = payment.merchantUid
    if (typeof customerAmount !== "number" || !Number.isFinite(customerAmount) || customerAmount <= 0 || typeof merchantUid !== "string" || merchantUid.trim() === "" || merchantUid !== merchantUid.trim()) {
      settlementReconcilingEvidence.skipped++
      continue
    }
    const evidence = await reconcileIncompleteA2UPayment(id, customerAmount, merchantUid)
    settlementReconcilingEvidence[evidence.outcome]++
  }

  if (!await drainLease.renew()) return NextResponse.json({ error: "Transient drain lease ownership lost" }, { status: 503 })
  console.log("[P7J5 LEASE] renewed before cursor handoff")

  try {
    const cursorCasResult = await redis.eval<[string, string], number>(`local current = redis.call('GET', KEYS[1]) or 'c:0'
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`, ["flashpay:recovery:active-payments:v1:scan-cursor"], [scanStartToken, scanNextToken])
    if (cursorCasResult !== 0 && cursorCasResult !== 1) return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  } catch {
    return NextResponse.json({ error: "Active recovery index unavailable" }, { status: 503 })
  }

  const workDurationMs = Date.now() - workStartedAt
  const wakeDurationMs = Date.now() - wakeStartedAt
  console.log("[P7H CAPACITY] transient wake", { discoveryDurationMs, workDurationMs, wakeDurationMs, activeSetSize, keys: keys.length, postHorizonIds: postHorizonIds.length, preparedSubmitIds: preparedSubmitIds.length, retryableIds: retryableIds.length, freshDispatchIds: freshDispatchIds.length, settlementReconcilingDiscoveryIds: settlementReconcilingDiscoveryIds.length, staleRetryReconcilingDiscoveryIds: staleRetryReconcilingDiscoveryIds.length, refundCandidateIds: refundCandidateIds.length, eligibleIds: eligibleIds.length, results: results.length, refundResults: refundResults.length, boundedPipelineConcurrency: BOUNDED_PIPELINE_CONCURRENCY, settlementPipelinePeakInFlight, refundIntakePeakInFlight, piCreateBackpressureActive: piCreateBackpressureActive(), piCreateBackpressureUntilMs, piCreateBackpressureUnavailable, walletDrainFairnessClass, walletDrainFairnessSelectedLane: preHead?.lane ?? null, walletDrainFairnessPreparedOverride: preHead?.lane === "prepared", walletDrainFairnessFreshCreateSuppressed: piCreateBackpressureActive() && (readyShadowFreshCreateIds?.length ?? 0) > 0, walletDrainBurstLimit: WALLET_DRAIN_BURST_LIMIT, walletDrainBurstBudgetMs: WALLET_DRAIN_BURST_BUDGET_MS, walletDrainBurstDurationMs, walletDrainBurstSettlementAttempts, walletDrainBurstRefundAttempts, walletDrainBurstStopReason, walletDrainBurstLanes, readySampleSize: readySample.length, readySetSize, readyIndexed, readyMissing, readyOrderedCount, readyFirstScore, readyLastScore, readyStrictlyIncreasing, readyClassInvalid, readyClassPostHorizon, readyClassPrepared, readyClassRetryable, readyClassFresh, readyClassStage1Only, readyClassReconciling, readyClassOther, readyShadowEligibleIds, readyShadowPreparedIds, readyShadowFreshIds, readyShadowReconcilingIds, walletDrainShadowCount, walletDrainShadowHeadPaymentId, walletDrainShadowHeadRefundId, walletDrainShadowHeadKind, walletDrainSelectedHeadKind, walletDrainSelectedHeadPaymentId, walletDrainSelectedHeadRefundId, walletDrainSelectedHeadParity, walletDrainPreExecutionHeadKind, walletDrainPreExecutionHeadPaymentId, walletDrainPreExecutionHeadRefundId, walletDrainNonEmptyParity, walletDrainNonMoneyCertification, readyCoverageCount: readyCoverageAllIds.length, readyCoverageTruncated, readyCoverageIndexed, readyCoverageMissing, readyHeadTruncated, readyCoverageOutsideHead, readyResidencyCount, readyResidencyMissing, readyResidencyBackfilled, readyEligibleSetParity, readyFreshSetParity, readyReconcilingSetParity, readyAuthorityCertified, readySchedulerUsable, readyBaselineCertified, readyRotationStart, readyRotationNext, readyRotationCas, readyRotationCycleMax, readyRotationCycleGeneration, readyWindowCertified, readyExecutionSource: useReadyExecution ? "ready" : "legacy" })

  return NextResponse.json({ processed: results.length, results, refundIntake: { processed: refundResults.length, results: refundResults }, refundPass, settlementDispatchDiscovery: { count: freshDispatchIds.length }, settlementReconcilingDiscovery: { count: settlementReconcilingDiscoveryIds.length }, staleRetryReconcilingDiscovery: { count: staleRetryReconcilingDiscoveryIds.length }, settlementReconcilingEvidence, boundedPipeline: { concurrency: BOUNDED_PIPELINE_CONCURRENCY, settlementPeakInFlight: settlementPipelinePeakInFlight, refundIntakePeakInFlight }, piCreateBackpressure: { active: piCreateBackpressureActive(), untilMs: piCreateBackpressureUntilMs, unavailable: piCreateBackpressureUnavailable }, walletDrainFairness: { class: walletDrainFairnessClass, selectedLane: preHead?.lane ?? null, preparedOverride: preHead?.lane === "prepared", freshCreateSuppressed: piCreateBackpressureActive() && (readyShadowFreshCreateIds?.length ?? 0) > 0 }, walletDrainBurst: { limit: WALLET_DRAIN_BURST_LIMIT, budgetMs: WALLET_DRAIN_BURST_BUDGET_MS, durationMs: walletDrainBurstDurationMs, settlementAttempts: walletDrainBurstSettlementAttempts, refundAttempts: walletDrainBurstRefundAttempts, stopReason: walletDrainBurstStopReason, lanes: walletDrainBurstLanes }, drainLease: "acquired" })
  } finally {
    const released = await drainLease.release()
    if (released) console.log("[P7J5 LEASE] released")
    else console.warn("[P7J5 LEASE] release skipped or ownership changed")
  }
}
