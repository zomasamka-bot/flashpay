import { redis } from "@/lib/redis"
import { randomUUID } from "crypto"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2ULocked, isStage1OnlySettlementDispatchCandidate } from "@/lib/a2u-locked-executor"
import { markRefundPendingAfterFailedSettlement } from "@/lib/types"
import { reconcileIncompleteA2UPayment, isPiA2UPayment, isRecord } from "@/lib/pi-reconciliation"
import { persistCheckpointMerged } from "@/lib/a2u-executor"
import { findRefundCheckpointByPaymentId } from "@/lib/refund-checkpoint-store"
import type { Payment } from "@/lib/types"

/**
 * A2U RECOVERY ORCHESTRATOR - Pure orchestrator, no business logic
 *
 * Responsibilities (AND ONLY THESE):
 * 1. Load canonical Payment from Redis
 * 2. Classify exact state from 5 precise flags
 * 3. Delegate to unified executor with identical parameters
 * 4. Return buildA2USuccessResponse (no independent success marking)
 *
 * CRITICAL GUARANTEES:
 * - Recovery NEVER creates new customer U2A (executor reuses a2uPaymentId or creates on demand for new payments only)
 * - Recovery NEVER resubmits Horizon when a2uTxid or horizonSuccessFlag exists (executor skips stage 2)
 * - Recovery NEVER marks success independently (executor marks after DB verified in stage 4)
 * - NO duplicate DB reconciliation logic (ALL delegated to executor stage 4)
 * - NO separate Pi /complete logic (ALL delegated to executor stage 3)
 * - NO PaymentState retention (use canonical Payment only)
 *
 * EXACT RECOVERY STATE DECISION TABLE:
 * ┌─────────────────┬──────────────────┬───────────────┬───────────────┬──────────────────────┐
 * │ State #         │ Conditions       │ a2uTxid?      │ Executor Call │ Expected Executor    │
 * ├─────────────────┼──────────────────┼───────────────┼───────────────┼──────────────────────┤
 * │ STATE 1: FINAL  │ status==settled  │ must exist    │ YES (isRec=T) │ Stage 0: return      │
 * │                 │ + piCompleted    │ + must exist  │ skip 1-3      │ success + txid       │
 * │                 │ + dbRecorded     │               │               │ (settled_to_merch)   │
 * ├─────────────────┼──────────────────┼───────────────┼───────────────┼──────────────────────┤
 * │ STATE 2: DB-    │ requiresDbRecon  │ must exist    │ YES (isRec=T) │ Stage 4: DB only     │
 * │ PENDING         │ + horizonSuccess │ + horizonFlag │ skip 1-3      │ mark settled_to_merch│
 * │                 │ + a2uTxid        │ required      │               │                      │
 * ├─────────────────┼──────────────────┼───────────────┼───────────────┼──────────────────────┤
 * │ STATE 3: Pi-    │ settlement_pend  │ must exist    │ YES (isRec=T) │ Stage 3: Pi /complete│
 * │ PENDING         │ + piCompletion   │ + horizonFlag │ skip 1-2      │ Stage 4: DB          │
 * │                 │ Pending + a2uTxid│ required      │               │ settled_to_merch     │
 * ├─────────────────┼──────────────────┼───────────────┼───────────────┼──────────────────────┤
 * │ STATE 4: EARLY  │ piCompleted      │ must exist    │ YES (isRec=T) │ Stage 4: DB only     │
 * │ DETECTION       │ + !requiresDb    │ + horizonFlag │ skip 1-3      │ settled_to_merch     │
 * │ (already_compl) │ Recon            │ required      │               │                      │
 * │                 │ + horizonSuccess │               │               │                      │
 * ├─────────────────┼──────────────────┼───────────────┼───────────────┼──────────────────────┤
 * │ STATE 5: IRREV  │ settlement_fail  │ if exists     │ NONE          │ N/A - irreversible   │
 * │ OR SAFE-RETRY   │ + a2uTxid exists │ + horizonFlag │ return error  │ (cannot restart H)   │
 * │                 │ OR horizonFlag   │ = irreversible│               │                      │
 * │                 │ then IRREVERSIB  │ if absent     │ might retry   │                      │
 * │                 │ else safe retry  │ = safe        │ in future     │                      │
 * └─────────────────┴──────────────────┴───────────────┴───────────────┴──────────────────────┘
 *
 * EXECUTOR CALL PATTERN (identical for all states):
 * executeA2U({
 *   paymentId,
 *   payment,           // canonical Payment from Redis
 *   merchantUid: payment.merchantUid,
 *   accessToken: payment.accessToken,
 *   customerAmount: payment.customerAmount || payment.amount,
 *   piPaymentId: payment.piPaymentId,
 *   isRecovery: true   // tells executor to skip completed stages
 * })
 *
 * POST-DELEGATION BEHAVIOR (identical for all callable states):
 * - Success: buildA2USuccessResponse(paymentId) → read Redis checkpoint
 * - Failure: return error state (executor updates Redis with checkpoint)
 */

interface RecoveryResult {
  status:
    | "success"
    | "db_reconciled"
    | "pending_pi_complete"
    | "irreversible"
    | "manual_review_required"
  state: string
  paymentId: string
  details: {
    u2aTxid?: string
    a2uTxid?: string
    error?: string
  }
}

async function commitRecoverySettlement(paymentId: string, mode: 6 | 7, customerAmount: number, merchantUid: string): Promise<"FOUND" | "CONFIRMED_NONE" | "INDETERMINATE" | "MANUAL_REVIEW"> {
  const lockKey = `flashpay:payment:operation:${paymentId}`
  const lockToken = randomUUID()
  if (await redis.set(lockKey, lockToken, { nx: true, ex: 600 }) !== "OK") return "MANUAL_REVIEW"
  try {
    const latestData = await redis.get(`payment:${paymentId}`)
    const latest: Payment | null = latestData ? (typeof latestData === "string" ? JSON.parse(latestData) : latestData) : null
    const refundLookup = await findRefundCheckpointByPaymentId(paymentId)
    const stateMatches = mode === 6
      ? latest?.settlementFailureState === "held" || latest?.settlementFailureState === "manual_review_required"
      : latest?.status === "settlement_failed"
    if (!latest || latest.id !== paymentId || !stateMatches || latest.customerAmount !== customerAmount || latest.merchantUid !== merchantUid || latest.a2uPaymentId || latest.a2uTxid || latest.a2uPreparedTxHash || latest.a2uPreparedSequence || latest.a2uPreparedEnvelopeXdr || latest.horizonSuccessFlag || latest.refundPaymentId || latest.refundTxid || refundLookup.state !== "absent") return "MANUAL_REVIEW"

    const reconciliation = await reconcileIncompleteA2UPayment(paymentId, latest.customerAmount, latest.merchantUid)
    if (reconciliation.outcome === "INDETERMINATE") return "INDETERMINATE"
    if (reconciliation.outcome === "FOUND") {
      if (!reconciliation.dto || !isPiA2UPayment(reconciliation.dto)) return "MANUAL_REVIEW"
      const identifier = reconciliation.dto.identifier
      if (typeof identifier !== "string" || identifier.trim().length === 0) return "MANUAL_REVIEW"
      const transaction = isRecord(reconciliation.dto.transaction) ? reconciliation.dto.transaction : null
      await persistCheckpointMerged(paymentId, { a2uPaymentId: identifier, ...(typeof transaction?.txid === "string" ? { a2uTxid: transaction.txid } : {}) })
      return "FOUND"
    }
    if (reconciliation.outcome !== "CONFIRMED_NONE") return "MANUAL_REVIEW"

    const refundPending = markRefundPendingAfterFailedSettlement(
      mode === 6 ? { ...latest, status: "settlement_failed" } : latest,
      {
        code: latest.a2uErrorCode || "a2u_non_retryable_no_transfer",
        message: "A2U failed before any merchant transfer evidence existed",
        occurredAt: new Date().toISOString(),
      },
    )
    if (refundPending.refundStatus !== "pending" || refundPending.settlementFailureState !== "refund_pending") return "MANUAL_REVIEW"
    await persistCheckpointMerged(paymentId, {
      status: refundPending.status,
      settlementFailureState: refundPending.settlementFailureState,
      payerRefundEligible: refundPending.payerRefundEligible,
      a2uErrorCode: refundPending.a2uErrorCode,
      a2uErrorMessage: refundPending.a2uErrorMessage,
      lastAttemptAt: refundPending.lastAttemptAt,
      refundStatus: refundPending.refundStatus,
    })
    return "CONFIRMED_NONE"
  } finally {
    try {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [lockKey], [lockToken])
    } catch (error) {
      console.warn("[A2U Recovery] Failed to release payment operation lock", error)
    }
  }
}

/**
 * MINIMAL ORCHESTRATOR - classify state and delegate only
 * Returns unified response via buildA2USuccessResponse (never marks success here)
 */
export async function executeA2URecovery(
  paymentId: string
): Promise<RecoveryResult> {
  console.log("[A2U Recovery] 🔍 Starting orchestrator for:", paymentId)

  // Load canonical Payment
  const paymentKey = `payment:${paymentId}`
  const paymentData = await redis.get(paymentKey)

  if (!paymentData) {
    console.error(
      "[A2U Recovery] ❌ Payment not found in Redis:",
      paymentId
    )
    return {
      status: "manual_review_required",
      state: "payment_not_found",
      paymentId,
      details: { error: "Payment not found in Redis" },
    }
  }

  const payment: Payment =
    typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

  console.log("[A2U Recovery] State flags:", {
    status: payment.status,
    requiresDbReconciliation: payment.requiresDbReconciliation,
    horizonSuccessFlag: payment.horizonSuccessFlag,
    piCompletionPending: payment.piCompletionPending,
    piCompleted: payment.piCompleted,
    dbRecorded: payment.dbRecorded,
    a2uTxid: payment.a2uTxid ? "exists" : "missing",
    horizonFeeCharged: payment.horizonFeeCharged,
  })

  // ===== STATE 1: FINAL SUCCESS =====
  // Already settled to merchant, all work complete
  // Executor will return stage 0 (early exit with stored txid/fee)
  if (
    payment.status === "settled_to_merchant" &&
    payment.piCompleted === true &&
    payment.dbRecorded === true
  ) {
    console.log(
      "[A2U Recovery] ✅ STATE 1: Final success - delegating to executor"
    )

    const result = await executeA2ULocked({
      paymentId,
      isRecovery: true,
    })

    if (!result.ok) {
      return {
        status: "manual_review_required",
        state: "state1_executor_failed",
        paymentId,
        details: { error: result.error },
      }
    }

    const response = await buildA2USuccessResponse(paymentId)
    if (!response || response.success !== true || response.status !== "settled_to_merchant") {
      return {
        status: "manual_review_required",
        state: "state1_response_failed",
        paymentId,
        details: { error: "Response building failed" },
      }
    }

    return {
      status: "success",
      state: "final_success",
      paymentId,
      details: {
        u2aTxid: response.u2aTxid,
        a2uTxid: response.a2uTxid,
      },
    }
  }

  // ===== STATE 2: DB RECONCILIATION PENDING =====
  // Horizon succeeded + a2uTxid exists, but DB record not made yet
  // Executor stage 4 only (skip 1-3)
  if (
    payment.requiresDbReconciliation === true &&
    payment.a2uTxid &&
    payment.horizonSuccessFlag === true
  ) {
    console.log(
      "[A2U Recovery] 🔄 STATE 2: DB reconciliation pending - delegating to executor stage 4"
    )

    const result = await executeA2ULocked({
      paymentId,
      isRecovery: true,
    })

    if (!result.ok) {
      return {
        status: "manual_review_required",
        state: "state2_executor_failed",
        paymentId,
        details: { error: result.error },
      }
    }

    const response = await buildA2USuccessResponse(paymentId)
    if (!response || response.success !== true || response.status !== "settled_to_merchant") {
      return {
        status: "manual_review_required",
        state: "state2_response_failed",
        paymentId,
        details: { error: "Response building failed" },
      }
    }

    return {
      status: "success",
      state: "db_reconciled",
      paymentId,
      details: {
        u2aTxid: response.u2aTxid,
        a2uTxid: response.a2uTxid,
      },
    }
  }

  // ===== STATE 3: PI /COMPLETE PENDING =====
  // Horizon succeeded (a2uTxid exists) but Pi /complete and DB not yet done
  // Executor stages 3 and 4 (skip 1-2)
  if (
    payment.status === "settlement_pending" &&
    typeof payment.a2uPaymentId === "string" && payment.a2uPaymentId.trim().length > 0 && payment.a2uPaymentId === payment.a2uPaymentId.trim() &&
    typeof payment.a2uPreparedEnvelopeXdr === "string" && payment.a2uPreparedEnvelopeXdr.trim().length > 0 && payment.a2uPreparedEnvelopeXdr === payment.a2uPreparedEnvelopeXdr.trim() &&
    typeof payment.a2uFromAddress === "string" && payment.a2uFromAddress.trim().length > 0 && payment.a2uFromAddress === payment.a2uFromAddress.trim() &&
    typeof payment.a2uToAddress === "string" && payment.a2uToAddress.trim().length > 0 && payment.a2uToAddress === payment.a2uToAddress.trim() &&
    typeof payment.a2uTxid === "string" && /^[0-9a-f]{64}$/.test(payment.a2uTxid) && payment.a2uTxid === payment.a2uTxid.trim() &&
    typeof payment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(payment.a2uPreparedTxHash) && payment.a2uPreparedTxHash === payment.a2uPreparedTxHash.trim() && payment.a2uTxid === payment.a2uPreparedTxHash &&
    typeof payment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(payment.a2uPreparedSequence) &&
    typeof payment.merchantAmount === "number" && Number.isFinite(payment.merchantAmount) && payment.merchantAmount > 0 &&
    payment.horizonSuccessFlag === true && typeof payment.horizonFeeCharged === "number" && Number.isFinite(payment.horizonFeeCharged) && payment.horizonFeeCharged >= 0 &&
    payment.piCompletionPending === true && payment.piCompleted !== true &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined && (payment.refundStatus === undefined || payment.refundStatus === "not_started")
  ) {
    console.log(
      "[A2U Recovery] 🔁 STATE 3: Pi /complete pending - delegating to executor stages 3-4"
    )

    const result = await executeA2ULocked({
      paymentId,
      isRecovery: true,
    })

    if (!result.ok) {
      return {
        status: "manual_review_required",
        state: "state3_executor_failed",
        paymentId,
        details: { error: result.error },
      }
    }

    const response = await buildA2USuccessResponse(paymentId)
    if (!response || response.success !== true || response.status !== "settled_to_merchant") {
      return {
        status: "manual_review_required",
        state: "state3_response_failed",
        paymentId,
        details: { error: "Response building failed" },
      }
    }

    return {
      status: "success",
      state: "pi_complete_and_db_reconciled",
      paymentId,
      details: {
        u2aTxid: response.u2aTxid,
        a2uTxid: response.a2uTxid,
      },
    }
  }

  // ===== STATE 4: EARLY DETECTION OF ALREADY_COMPLETED =====
  // Payment already completed on Pi but DB record not yet created (refetched and validated by executor)
  // Executor stages 4 only (skip 1-3)
  if (
    payment.piCompleted === true &&
    payment.requiresDbReconciliation !== true &&
    payment.a2uTxid &&
    payment.horizonSuccessFlag === true
  ) {
    console.log(
      "[A2U Recovery] 📊 STATE 4: Already-completed on Pi - delegating to executor stage 4"
    )

    const result = await executeA2ULocked({
      paymentId,
      isRecovery: true,
    })

    if (!result.ok) {
      return {
        status: "manual_review_required",
        state: "state4_executor_failed",
        paymentId,
        details: { error: result.error },
      }
    }

    const response = await buildA2USuccessResponse(paymentId)
    if (!response || response.success !== true || response.status !== "settled_to_merchant") {
      return {
        status: "manual_review_required",
        state: "state4_response_failed",
        paymentId,
        details: { error: "Response building failed" },
      }
    }

    return {
      status: "success",
      state: "early_detection_reconciled",
      paymentId,
      details: {
        u2aTxid: response.u2aTxid,
        a2uTxid: response.a2uTxid,
      },
    }
  }

  // ===== SETTLEMENT SUBMIT RECOVERY =====
  if (
    payment.status === "settlement_pending" &&
    typeof payment.a2uPaymentId === "string" && payment.a2uPaymentId.trim().length > 0 && payment.a2uPaymentId === payment.a2uPaymentId.trim() &&
    typeof payment.a2uPreparedEnvelopeXdr === "string" && payment.a2uPreparedEnvelopeXdr.trim().length > 0 && payment.a2uPreparedEnvelopeXdr === payment.a2uPreparedEnvelopeXdr.trim() &&
    typeof payment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(payment.a2uPreparedTxHash) &&
    typeof payment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(payment.a2uPreparedSequence) &&
    typeof payment.a2uFromAddress === "string" && payment.a2uFromAddress.trim().length > 0 && payment.a2uFromAddress === payment.a2uFromAddress.trim() &&
    typeof payment.a2uToAddress === "string" && payment.a2uToAddress.trim().length > 0 && payment.a2uToAddress === payment.a2uToAddress.trim() &&
    typeof payment.customerAmount === "number" && Number.isFinite(payment.customerAmount) && payment.customerAmount > 0 &&
    typeof payment.merchantAmount === "number" && Number.isFinite(payment.merchantAmount) && payment.merchantAmount > 0 &&
    payment.a2uTxid === undefined &&
    payment.horizonSuccessFlag !== true && payment.piCompletionPending !== true && payment.piCompleted !== true && payment.requiresDbReconciliation !== true && payment.dbRecorded !== true &&
    payment.refundPaymentId === undefined && payment.refundTxid === undefined &&
    (payment.refundStatus === undefined || payment.refundStatus === "not_started")
  ) {
    const result = await executeA2ULocked({ paymentId, isRecovery: true, recoveryOperation: "SETTLEMENT_SUBMIT" })
    if (!result.ok) {
      return { status: "manual_review_required", state: "settlement_submit_recovery_failed", paymentId, details: { error: result.error } }
    }
    const rereadData = await redis.get(paymentKey)
    const rereadPayment: Payment | null = rereadData ? (typeof rereadData === "string" ? JSON.parse(rereadData) : rereadData) : null
    const refundLookup = await findRefundCheckpointByPaymentId(paymentId)
    const checkpoint = rereadPayment
    const validCheckpoint = refundLookup.state === "absent" && checkpoint !== null &&
      checkpoint.status === "settlement_pending" &&
      typeof checkpoint.a2uPaymentId === "string" && checkpoint.a2uPaymentId.trim().length > 0 && checkpoint.a2uPaymentId === checkpoint.a2uPaymentId.trim() &&
      typeof checkpoint.a2uPreparedEnvelopeXdr === "string" && checkpoint.a2uPreparedEnvelopeXdr.trim().length > 0 && checkpoint.a2uPreparedEnvelopeXdr === checkpoint.a2uPreparedEnvelopeXdr.trim() &&
      typeof checkpoint.a2uFromAddress === "string" && checkpoint.a2uFromAddress.trim().length > 0 && checkpoint.a2uFromAddress === checkpoint.a2uFromAddress.trim() &&
      typeof checkpoint.a2uToAddress === "string" && checkpoint.a2uToAddress.trim().length > 0 && checkpoint.a2uToAddress === checkpoint.a2uToAddress.trim() &&
      typeof checkpoint.a2uTxid === "string" && /^[0-9a-f]{64}$/.test(checkpoint.a2uTxid) && checkpoint.a2uTxid === checkpoint.a2uTxid.trim() &&
      typeof checkpoint.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(checkpoint.a2uPreparedTxHash) && checkpoint.a2uPreparedTxHash === checkpoint.a2uPreparedTxHash.trim() && checkpoint.a2uTxid === checkpoint.a2uPreparedTxHash &&
      typeof checkpoint.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(checkpoint.a2uPreparedSequence) &&
      typeof checkpoint.merchantAmount === "number" && Number.isFinite(checkpoint.merchantAmount) && checkpoint.merchantAmount > 0 &&
      checkpoint.horizonSuccessFlag === true && typeof checkpoint.horizonFeeCharged === "number" && Number.isFinite(checkpoint.horizonFeeCharged) && checkpoint.horizonFeeCharged >= 0 &&
      checkpoint.piCompletionPending === true && checkpoint.piCompleted !== true &&
      checkpoint.refundPaymentId === undefined && checkpoint.refundTxid === undefined && (checkpoint.refundStatus === undefined || checkpoint.refundStatus === "not_started")
    if (validCheckpoint) {
      return { status: "pending_pi_complete", state: "settlement_submit_movement_checkpointed", paymentId, details: { a2uTxid: checkpoint.a2uTxid } }
    }
    return { status: "manual_review_required", state: "settlement_submit_movement_checkpoint_invalid", paymentId, details: { error: "Settlement movement checkpoint could not be verified" } }
  }

  if(payment.status==="paid_to_app"&&(payment.settlementFailureState===undefined&&typeof payment.settlementDispatchRequestedAt==="string"||isStage1OnlySettlementDispatchCandidate(payment,Date.now()))) {
    const result = await executeA2ULocked({ paymentId, isRecovery: true, recoveryOperation: "SETTLEMENT_DISPATCH" })
    if (!result.ok) {
      return { status: "manual_review_required", state: "settlement_dispatch_failed", paymentId, details: { error: result.error } }
    }
    const response = await buildA2USuccessResponse(paymentId)
    if (response?.success === true && response.status === "settled_to_merchant") {
      return { status: "success", state: "settlement_dispatch_completed", paymentId, details: { u2aTxid: response.u2aTxid, a2uTxid: response.a2uTxid } }
    }
    return { status: "manual_review_required", state: "settlement_dispatch_outcome_deferred", paymentId, details: {} }
  }

  if (payment.status === "paid_to_app" && payment.settlementFailureState === "reconciling") {
    const result = await executeA2ULocked({ paymentId, isRecovery: true, recoveryOperation: "SETTLEMENT_RECONCILE" })
    if (!result.ok) {
      return { status: "manual_review_required", state: "settlement_reconcile_failed", paymentId, details: { error: result.error } }
    }
    const response = await buildA2USuccessResponse(paymentId)
    if (response?.success === true && response.status === "settled_to_merchant") {
      return { status: "success", state: "settlement_reconcile_completed", paymentId, details: { u2aTxid: response.u2aTxid, a2uTxid: response.a2uTxid } }
    }
    return { status: "manual_review_required", state: "settlement_reconcile_outcome_deferred", paymentId, details: {} }
  }

  // ===== STATE 5: PAID-TO-APP RECOVERY =====
  // A2U creation failures are retryable only after their backoff window.
  if (payment.status === "paid_to_app" && payment.settlementFailureState === "retryable") {
    if (payment.a2uTxid || payment.horizonSuccessFlag) {
      return { status: "manual_review_required", state: "paid_to_app_has_transfer_evidence", paymentId, details: { a2uTxid: payment.a2uTxid, error: "Transfer evidence exists; recovery is blocked" } }
    }
    if (payment.a2uPaymentId !== undefined) {
      return { status: "manual_review_required", state: "settlement_submit_not_authorized", paymentId, details: { error: "Settlement Submit is not authorized" } }
    }
    if (payment.nextRetryAt && Date.parse(payment.nextRetryAt) > Date.now()) {
      return { status: "pending_pi_complete", state: "retry_backoff_active", paymentId, details: { error: "Retry backoff is active" } }
    }
    const result = await executeA2ULocked({ paymentId, isRecovery: true, recoveryOperation: "SETTLEMENT_CREATE" })
    if (!result.ok) {
      return { status: "manual_review_required", state: "paid_to_app_retry_failed", paymentId, details: { error: result.error } }
    }
    return { status: "manual_review_required", state: "settlement_create_outcome_deferred", paymentId, details: { error: "Settlement Create returned; reconcile before any submit" } }
  }

  // ===== STATE 6: REFUND SAFETY GATE =====
  // This code deliberately refuses to refund without verified payer eligibility and proof
  // that neither Pi A2U nor Horizon contains merchant-transfer evidence.
  if (payment.settlementFailureState === "held" || payment.settlementFailureState === "manual_review_required") {
    const hasMerchantEvidence = Boolean(payment.a2uPaymentId || payment.a2uTxid || payment.horizonSuccessFlag)
    if (hasMerchantEvidence) {
      return { status: "manual_review_required", state: "refund_blocked_transfer_evidence", paymentId, details: { a2uTxid: payment.a2uTxid, error: "Refund blocked until transfer evidence is reconciled" } }
    }
    if (payment.refundPaymentId || payment.refundTxid) {
      return { status: "manual_review_required", state: "refund_already_has_transfer_evidence", paymentId, details: { error: "Refund transfer evidence exists" } }
    }

    if (typeof payment.customerAmount !== "number" || !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0) {
      return { status: "manual_review_required", state: "a2u_reconciliation_amount_missing", paymentId, details: { error: "Verified settlement amount is required for A2U reconciliation" } }
    }
    if (typeof payment.merchantUid !== "string" || payment.merchantUid.trim().length === 0) {
      return { status: "manual_review_required", state: "a2u_reconciliation_merchant_uid_missing", paymentId, details: { error: "Merchant UID is required for scoped A2U reconciliation" } }
    }
    const commitResult = await commitRecoverySettlement(paymentId, 6, payment.customerAmount, payment.merchantUid)
    if (commitResult === "FOUND") return { status: "manual_review_required", state: "a2u_found_reused_from_stage1_reconciliation", paymentId, details: { error: "A2U evidence reconciled under payment lock" } }
    if (commitResult === "INDETERMINATE") return { status: "manual_review_required", state: "a2u_reconciliation_indeterminate", paymentId, details: { error: "A2U reconciliation remained indeterminate" } }
    if (commitResult === "CONFIRMED_NONE") return { status: "manual_review_required", state: "refund_pending_eligible", paymentId, details: { error: "Refund intent may now be created" } }
    return { status: "manual_review_required", state: "refund_implementation_guarded", paymentId, details: { error: "Refund eligibility or verified payer scope cannot be proven" } }
  }

  // ===== STATE 7: SETTLEMENT FAILED - CHECK IRREVERSIBILITY =====
  // If a2uTxid or horizonSuccessFlag exists: irreversible (Horizon was submitted)
  // Otherwise: safe to retry (no Horizon submission occurred)
  if (payment.status === "settlement_failed") {
    if (payment.a2uTxid || payment.horizonSuccessFlag) {
      console.log(
        "[A2U Recovery] ❌ STATE 5: Irreversible failure (Horizon submitted, cannot retry)"
      )
      return {
        status: "irreversible",
        state: "irreversible_settlement_failure",
        paymentId,
        details: {
          error:
            "Horizon transaction submitted but settlement failed - contact support",
          a2uTxid: payment.a2uTxid,
        },
      }
    }

    if (typeof payment.customerAmount !== "number" || !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0) {
      return { status: "manual_review_required", state: "a2u_reconciliation_amount_missing", paymentId, details: { error: "Verified settlement amount is required for A2U reconciliation" } }
    }
    if (typeof payment.merchantUid !== "string" || payment.merchantUid.trim().length === 0) {
      return { status: "manual_review_required", state: "a2u_reconciliation_merchant_uid_missing", paymentId, details: { error: "Merchant UID is required for scoped A2U reconciliation" } }
    }
    const commitResult = await commitRecoverySettlement(paymentId, 7, payment.customerAmount, payment.merchantUid)
    if (commitResult === "FOUND") return { status: "manual_review_required", state: "a2u_found_reused_from_stage1_reconciliation", paymentId, details: { error: "A2U evidence reconciled under payment lock" } }
    if (commitResult === "INDETERMINATE") return { status: "manual_review_required", state: "a2u_reconciliation_indeterminate", paymentId, details: { error: "A2U reconciliation remained indeterminate" } }
    if (commitResult === "CONFIRMED_NONE") return { status: "manual_review_required", state: "refund_pending_eligible", paymentId, details: { error: "No merchant transfer evidence; refund intent may be created" } }
    if (commitResult === "MANUAL_REVIEW") return { status: "manual_review_required", state: "recovery_commit_guarded", paymentId, details: { error: "Recovery commit was guarded" } }

    console.log(
      "[A2U Recovery] Safe failure remains non-refundable: verified payer/failure proof incomplete"
    )
    return {
      status: "manual_review_required",
      state: "failure_safe_to_retry_later",
      paymentId,
      details: { error: "Settlement failed but trusted refund eligibility was not proven" },
    }
  }

  // No state matched - unknown condition
  console.log(
    "[A2U Recovery] ⚠️ No recovery state matched for:",
    payment.status
  )
  return {
    status: "manual_review_required",
    state: "no_recovery_state_matched",
    paymentId,
    details: {
      error: `Unknown recovery state for status: ${payment.status}`,
    },
  }
}

/**
 * Check if payment can be recovered (used by /api/recovery route gate)
 */
export function isPaymentRecoverable(payment: Payment): boolean {
  // Must be in one of these terminal or semi-terminal states
  const recoverableStates = [
    "settled_to_merchant",
    "settlement_pending",
    "settlement_failed",
    "paid_to_app",
    "refund_pending",
  ]

  if (!recoverableStates.includes(payment.status)) {
    return false
  }

  // settlement_failed is only recoverable if NO Horizon identifiers (safe to retry)
  if (
    payment.status === "settlement_failed" &&
    (payment.a2uTxid || payment.horizonSuccessFlag)
  ) {
    return false
  }

  return true
}

/**
 * Extract recovery diagnostics for logging (no business logic)
 */
export function getRecoveryHints(payment: Payment): Record<
  string,
  unknown
> {
  return {
    status: payment.status,
    requiresDbReconciliation: payment.requiresDbReconciliation,
    horizonSuccessFlag: payment.horizonSuccessFlag,
    piCompletionPending: payment.piCompletionPending,
    piCompleted: payment.piCompleted,
    dbRecorded: payment.dbRecorded,
    hasA2UTxid: !!payment.a2uTxid,
    hasU2ATxid: !!payment.u2aTxid,
    horizonFeeCharged: payment.horizonFeeCharged,
    isRecoverable: isPaymentRecoverable(payment),
  }
}
