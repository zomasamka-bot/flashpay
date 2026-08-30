import { timingSafeEqual } from "crypto"
import { type NextRequest, NextResponse } from "next/server"

import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { ensureAutomaticRefundIntent, runAutomaticRefundPass } from "@/lib/refund-auto-orchestrator"
import { ensureRefundAccountingTable } from "@/lib/db"
import { isRefundEligible as checkRefundEligibility } from "@/lib/types"
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

  const keys = await redis.keys("payment:*")
  const postHorizonIds: string[] = []
  const preparedSubmitIds: string[] = []
  const retryableIds: string[] = []
  const refundCandidateIds: string[] = []
  const now = Date.now()

  for (const key of keys) {
    const payment = parsePayment(await redis.get(key))
    if (!payment) continue

    const paymentId = key.slice("payment:".length)
    if (payment.id === paymentId && checkRefundEligibility(payment)) {
      refundCandidateIds.push(paymentId)
    }
    if (payment.id !== paymentId) continue
    if (isPostHorizonEligible(payment, now)) {
      postHorizonIds.push(paymentId)
    } else if (isPreparedSubmitEligible(payment)) {
      preparedSubmitIds.push(paymentId)
    } else if (isEligible(payment, now)) {
      retryableIds.push(paymentId)
    }
  }

  const eligibleIds = [...postHorizonIds, ...preparedSubmitIds, ...retryableIds].slice(0, MAX_ATTEMPTS)

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

  const refundAccountingReady = await ensureRefundAccountingTable()
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

  return NextResponse.json({ processed: results.length, results, refundIntake: { processed: refundResults.length, results: refundResults }, refundPass })
}
