import { redis } from "@/lib/redis"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2ULocked } from "@/lib/a2u-locked-executor"
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
    if (!response) {
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
    if (!response) {
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
    payment.piCompletionPending === true &&
    payment.a2uTxid &&
    payment.a2uPaymentId
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
    if (!response) {
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
    if (!response) {
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

  // ===== STATE 5: SETTLEMENT FAILED - CHECK IRREVERSIBILITY =====
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

    // No Horizon identifiers = safe to retry in future
    console.log(
      "[A2U Recovery] 🔄 STATE 5: Safe to retry (no Horizon submission occurred yet)"
    )
    return {
      status: "manual_review_required",
      state: "failure_safe_to_retry_later",
      paymentId,
      details: { error: "Settlement failed but safe to retry later" },
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
