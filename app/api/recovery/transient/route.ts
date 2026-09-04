import { timingSafeEqual } from "crypto"
import { type NextRequest, NextResponse } from "next/server"

import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"
import { isStage1OnlySettlementDispatchCandidate } from "@/lib/a2u-locked-executor"
import { ensureAutomaticRefundIntent, runAutomaticRefundPass } from "@/lib/refund-auto-orchestrator"
import { ensureRefundAccountingTable } from "@/lib/db"
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
  const keys = await redis.keys("payment:*")
  const postHorizonIds: string[] = []
  const preparedSubmitIds: string[] = []
  const retryableIds: string[] = []
  const freshDispatchIds: string[] = []
  const settlementReconcilingDiscoveryIds: string[] = []
  const staleRetryReconcilingDiscoveryIds: string[] = []
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

  const workDurationMs = Date.now() - workStartedAt
  const wakeDurationMs = Date.now() - wakeStartedAt
  console.log("[P7H CAPACITY] transient wake", { discoveryDurationMs, workDurationMs, wakeDurationMs, keys: keys.length, postHorizonIds: postHorizonIds.length, preparedSubmitIds: preparedSubmitIds.length, retryableIds: retryableIds.length, freshDispatchIds: freshDispatchIds.length, settlementReconcilingDiscoveryIds: settlementReconcilingDiscoveryIds.length, staleRetryReconcilingDiscoveryIds: staleRetryReconcilingDiscoveryIds.length, refundCandidateIds: refundCandidateIds.length, eligibleIds: eligibleIds.length, results: results.length, refundResults: refundResults.length })

  return NextResponse.json({ processed: results.length, results, refundIntake: { processed: refundResults.length, results: refundResults }, refundPass, settlementDispatchDiscovery: { count: freshDispatchIds.length }, settlementReconcilingDiscovery: { count: settlementReconcilingDiscoveryIds.length }, staleRetryReconcilingDiscovery: { count: staleRetryReconcilingDiscoveryIds.length }, settlementReconcilingEvidence })
}
