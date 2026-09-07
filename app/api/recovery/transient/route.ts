import { timingSafeEqual } from "crypto"
import { type NextRequest, NextResponse } from "next/server"

import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { isStage1OnlySettlementDispatchCandidate } from "@/lib/a2u-locked-executor"
import { ensureAutomaticRefundIntent, runAutomaticRefundPass } from "@/lib/refund-auto-orchestrator"
import { query } from "@/lib/db"
import { isRefundEligible as checkRefundEligibility } from "@/lib/types"
import { reconcileIncompleteA2UPayment } from "@/lib/pi-reconciliation"
import type { Payment } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_ATTEMPTS = 5
const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"

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

function isTooManyPayments(payment: Payment): boolean {
  return payment.a2uErrorCode === "too_many_payments"
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  if (!isRedisConfigured) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 500 })
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
      if (!payment) continue

      const paymentId = key.slice("payment:".length)
      if (payment.id === paymentId && checkRefundEligibility(payment)) {
        refundCandidateIds.push(paymentId)
      }
      if (payment.id !== paymentId) continue
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
  try {
    const readyOrdered = await redis.zrange("flashpay:settlement:ready:v1", 0, 199, { withScores: true })
    if (!Array.isArray(readyOrdered) || readyOrdered.length > 400 || readyOrdered.length % 2 !== 0) throw new Error("Invalid ordered settlement ready telemetry")
    const orderedIds: string[] = []
    let orderedCount = readyOrdered.length / 2
    let firstScore: number | null = null
    let lastScore: number | null = null
    let strictlyIncreasing = true
    let previousScore: number | null = null
    for (let index = 0; index < readyOrdered.length; index += 2) {
      const member = readyOrdered[index]
      const score = readyOrdered[index + 1]
      if (typeof member !== "string" || member.length === 0 || member !== member.trim() || typeof score !== "number" || !Number.isFinite(score) || !Number.isSafeInteger(score) || score < 0) throw new Error("Invalid ordered settlement ready telemetry")
      orderedIds.push(member)
      if (previousScore !== null) {
        if (score < previousScore) throw new Error("Invalid ordered settlement ready telemetry")
        if (score <= previousScore) strictlyIncreasing = false
      } else {
        firstScore = score
      }
      previousScore = score
    }
    if (readyOrdered.length === 0) strictlyIncreasing = true
    orderedCount = readyOrdered.length / 2
    readyOrderedIds.push(...orderedIds)
    readyOrderedCount = orderedCount
    readyFirstScore = firstScore
    readyLastScore = previousScore
    readyStrictlyIncreasing = strictlyIncreasing
    readyOrderedValid = true
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready telemetry unavailable")
  }

  let readyClassInvalid: number | null = null
  let readyClassPostHorizon: number | null = null
  let readyClassPrepared: number | null = null
  let readyClassRetryable: number | null = null
  let readyClassFresh: number | null = null
  let readyClassStage1Only: number | null = null
  let readyClassReconciling: number | null = null
  let readyClassOther: number | null = null
  try {
    let classInvalid = 0
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
      const readyValues = await redis.mget<unknown[]>(readyOrderedIds.map((id) => `payment:${id}`))
      if (!Array.isArray(readyValues) || readyValues.length !== readyOrderedIds.length) throw new Error("Invalid ordered settlement ready payment telemetry")
      for (let index = 0; index < readyOrderedIds.length; index += 1) {
        const payment = parsePayment(readyValues[index])
        const paymentId = readyOrderedIds[index]
        if (!payment || payment.id !== paymentId) {
          classInvalid++
        } else if (isPostHorizonEligible(payment, now)) {
          classPostHorizon++
        } else if (isPreparedSubmitEligible(payment)) {
          classPrepared++
        } else if (isEligible(payment, now)) {
          classRetryable++
        } else if (isFreshSettlementDispatchCandidate(payment, now)) {
          classFresh++
        } else if (isStage1OnlySettlementDispatchCandidate(payment, now)) {
          classStage1Only++
        } else if (isStaleFreshReconcilingCandidate(payment, now) || isStaleRetryReconcilingCandidate(payment, now)) {
          classReconciling++
        } else {
          classOther++
        }
      }
    }
    readyClassInvalid = classInvalid
    readyClassPostHorizon = classPostHorizon
    readyClassPrepared = classPrepared
    readyClassRetryable = classRetryable
    readyClassFresh = classFresh
    readyClassStage1Only = classStage1Only
    readyClassReconciling = classReconciling
    readyClassOther = classOther
  } catch {
    console.warn("[P7H CAPACITY] ordered settlement ready classification unavailable")
  }

  const discoveryDurationMs = Date.now() - discoveryStartedAt

  const eligibleIds = [...postHorizonIds, ...preparedSubmitIds, ...retryableIds].slice(0, MAX_ATTEMPTS)

  const workStartedAt = Date.now()
  const results: Array<{ paymentId: string; ok: boolean; status?: string; error?: string }> = []

  for (const paymentId of eligibleIds) {
    const result = await executeA2URecovery(paymentId)
    const latest = parsePayment(await redis.get(`payment:${paymentId}`))

    results.push({
      paymentId,
      ok: result.status === "success" || result.status === "db_reconciled",
      status: latest?.status,
      error: result.details?.error,
    })

    if (
      latest &&
      latest.status === "paid_to_app" &&
      latest.settlementFailureState === "retryable" &&
      isTooManyPayments(latest)
    ) {
      break
    }
  }

for (const id of freshDispatchIds.slice(0,1)) { const payment=parsePayment(await redis.get(`payment:${id}`)); if(payment?.id!==id||!(isFreshSettlementDispatchCandidate(payment,Date.now()) || isStage1OnlySettlementDispatchCandidate(payment,Date.now()))) continue; const result=await executeA2URecovery(id); const latest=parsePayment(await redis.get(`payment:${id}`)); results.push({paymentId:id,ok:result.status==="success",status:latest?.status,error:result.details?.error}); }

  const settlementReconcilingExecutionIds=[...new Set([...settlementReconcilingDiscoveryIds,...staleRetryReconcilingDiscoveryIds])].slice(0,1)
  for (const id of settlementReconcilingExecutionIds) {
    const payment = parsePayment(await redis.get(`payment:${id}`))
    if (payment?.id !== id || (!isStaleFreshReconcilingCandidate(payment, Date.now()) && !isStaleRetryReconcilingCandidate(payment, Date.now()))) continue
    const result = await executeA2URecovery(id)
    const latest = parsePayment(await redis.get(`payment:${id}`))
    results.push({ paymentId: id, ok: result.status === "success", status: latest?.status, error: result.details?.error })
  }

  const refundAccountingReady = (await query("SELECT 1 FROM refund_accounting_records LIMIT 0")) !== null
  let refundPass: Awaited<ReturnType<typeof runAutomaticRefundPass>>
  const refundResults = []
  if (refundAccountingReady) {
    try {
      refundPass = await runAutomaticRefundPass(MAX_ATTEMPTS)
    } catch {
      refundPass = { state: "blocked" }
    }

    for (const paymentId of refundCandidateIds.slice(0, MAX_ATTEMPTS)) {
      try {
        refundResults.push(await ensureAutomaticRefundIntent(paymentId))
      } catch {
        refundResults.push({ outcome: "blocked", paymentId, reason: "intake_exception" })
      }
    }
  } else {
    refundPass = { state: "blocked" }
  }

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
  console.log("[P7H CAPACITY] transient wake", { discoveryDurationMs, workDurationMs, wakeDurationMs, activeSetSize, keys: keys.length, postHorizonIds: postHorizonIds.length, preparedSubmitIds: preparedSubmitIds.length, retryableIds: retryableIds.length, freshDispatchIds: freshDispatchIds.length, settlementReconcilingDiscoveryIds: settlementReconcilingDiscoveryIds.length, staleRetryReconcilingDiscoveryIds: staleRetryReconcilingDiscoveryIds.length, refundCandidateIds: refundCandidateIds.length, eligibleIds: eligibleIds.length, results: results.length, refundResults: refundResults.length, readySampleSize: readySample.length, readySetSize, readyIndexed, readyMissing, readyOrderedCount, readyFirstScore, readyLastScore, readyStrictlyIncreasing, readyClassInvalid, readyClassPostHorizon, readyClassPrepared, readyClassRetryable, readyClassFresh, readyClassStage1Only, readyClassReconciling, readyClassOther })

  return NextResponse.json({ processed: results.length, results, refundIntake: { processed: refundResults.length, results: refundResults }, refundPass, settlementDispatchDiscovery: { count: freshDispatchIds.length }, settlementReconcilingDiscovery: { count: settlementReconcilingDiscoveryIds.length }, staleRetryReconcilingDiscovery: { count: staleRetryReconcilingDiscoveryIds.length }, settlementReconcilingEvidence })
}
