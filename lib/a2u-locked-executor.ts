import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2U, persistCheckpointMerged } from "@/lib/a2u-executor"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import type { Payment } from "@/lib/types"
import { findRefundCheckpointByPaymentId } from "@/lib/refund-checkpoint-store"
import { readSettlementCreatePiEvidence } from "@/lib/financial-recovery-settlement-create-pi-reader"
import { evaluateFinancialRecoverySettlementCreateReadBinding } from "@/lib/financial-recovery-settlement-create-read-binding"
import { executeFinancialRecoverySettlementSubmitReplay } from "@/lib/financial-recovery-settlement-submit-replay-orchestration"
import { acquirePiWalletSubmitLock } from "@/lib/pi-wallet-submit-lock"
import * as StellarSDK from "@stellar/stellar-sdk"
import crypto from "crypto"

/**
 * SHARED CONCURRENCY LOCK FOR A2U EXECUTION
 * ============================================
 * 
 * ONE concurrency boundary for all A2U execution paths:
 * - /api/pi/a2u (A2U direct)
 * - /api/pi/complete (U2A completion)
 * - /api/recovery/[id] (recovery orchestration)
 * 
 * NO caller may invoke executeA2U directly.
 * 
 * Lock Strategy:
 * - Key: a2u:lock:${paymentId}
 * - NX + EX (expiry) + unique token
 * - Token-checked atomic release via Lua
 * - If lock fails: reread and return current state (no execution)
 */

interface LockedExecutorParams {
  paymentId: string
  isRecovery: boolean
  recoveryOperation?: "SETTLEMENT_CREATE" | "SETTLEMENT_SUBMIT"
}

/**
 * Execute A2U under ONE shared concurrency lock.
 * If lock acquisition fails, reread payment and return its current state.
 * CRITICAL: Inside lock, any valid a2uTxid or horizonSuccessFlag permanently skips Stage 2.
 * ALL returns MUST be numeric HTTP status codes (never string | number).
 */
export async function executeA2ULocked(params: LockedExecutorParams) {
  const { paymentId } = params
  
  const lockToken = crypto.randomUUID()
  // Shared with refund intent creation: A2U and refund cannot overlap.
  const lockKey = `flashpay:payment:operation:${paymentId}`
  const lockTtl = 600 // 10 minutes

  console.log("[A2U Locked Executor] Acquiring concurrency lock for paymentId:", paymentId)

  if (!isRedisConfigured) {
    console.error("[A2U Locked Executor] Redis not configured")
    return { ok: false, status: 500, error: "Server not configured" }
  }

  let lockAcquired = false
  try {
    const lockResult = await redis.set(lockKey, lockToken, { nx: true, ex: lockTtl })
    lockAcquired = lockResult === "OK"
  } catch (lockError) {
    console.error("[A2U Locked Executor] Lock acquisition error:", lockError)
  }

  const releaseLockAtomic = async () => {
    if (!lockAcquired || !isRedisConfigured) return
    try {
      const luaScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `
      await redis.eval(luaScript, [lockKey], [lockToken])
    } catch (error) {
      console.warn("[A2U Locked Executor] Failed to release lock atomically:", error)
    }
  }

  try {
    if (!lockAcquired) {
      console.warn("[A2U Locked Executor] Could not acquire lock - rereading current state")

      const paymentCheck = await redis.get(`payment:${paymentId}`)
      const payment = paymentCheck ? (typeof paymentCheck === "string" ? JSON.parse(paymentCheck) : paymentCheck) : null

      if (!payment) {
        console.error("[A2U Locked Executor] Payment not found")
        return { ok: false, status: 404, error: "Payment not found" }
      }

      // Return current authoritative state without executing
      console.log("[A2U Locked Executor] Returning current state - status:", payment.status)
      const response = await buildA2USuccessResponse(paymentId)
      if (!response) {
        return { ok: false, status: 500, error: "Failed to build response" }
      }
      return { ok: true, status: 200, data: response }
    }

    console.log("[A2U Locked Executor] ✓ Lock acquired")

    // Inside lock: reload LATEST payment checkpoint
    const paymentData = await redis.get(`payment:${paymentId}`)
    if (!paymentData) {
      console.error("[A2U Locked Executor] Payment not found after lock acquisition")
      return { ok: false, status: 404, error: "Payment not found" }
    }

    let latestPayment: Payment
    try {
      latestPayment = (typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData) as Payment
    } catch {
      return { ok: false, status: 409, error: "Payment state could not be verified" }
    }
    if (!latestPayment || typeof latestPayment !== "object") {
      return { ok: false, status: 409, error: "Payment state could not be verified" }
    }

    const refundLookup = await findRefundCheckpointByPaymentId(paymentId)
    if (refundLookup.state !== 'absent' && params.recoveryOperation !== "SETTLEMENT_CREATE") {
      return { ok: false, status: 409, error: refundLookup.state === 'present' ? "Refund operation owns this payment" : "Refund state could not be verified" }
    }

    if (params.recoveryOperation === undefined) {
      const canonicalA2UPaymentId = typeof latestPayment.a2uPaymentId === "string" && latestPayment.a2uPaymentId.trim() !== "" && latestPayment.a2uPaymentId === latestPayment.a2uPaymentId.trim()
      const canonicalA2UTxid = typeof latestPayment.a2uTxid === "string" && /^[0-9a-f]{64}$/.test(latestPayment.a2uTxid) && latestPayment.a2uTxid === latestPayment.a2uTxid.trim()
      const canonicalPreparedHash = typeof latestPayment.a2uPreparedTxHash === "string" && /^[0-9a-f]{64}$/.test(latestPayment.a2uPreparedTxHash) && latestPayment.a2uPreparedTxHash === latestPayment.a2uPreparedTxHash.trim()
      const canonicalPreparedSequence = typeof latestPayment.a2uPreparedSequence === "string" && /^[1-9][0-9]*$/.test(latestPayment.a2uPreparedSequence) && latestPayment.a2uPreparedSequence === latestPayment.a2uPreparedSequence.trim()
      const preparedPairAbsent = latestPayment.a2uPreparedTxHash === undefined && latestPayment.a2uPreparedSequence === undefined
      const preparedPairCanonical = canonicalPreparedHash && canonicalPreparedSequence
      const canonicalPreparedEnvelope = typeof latestPayment.a2uPreparedEnvelopeXdr === "string" && latestPayment.a2uPreparedEnvelopeXdr.trim() !== "" && latestPayment.a2uPreparedEnvelopeXdr === latestPayment.a2uPreparedEnvelopeXdr.trim()
      const preparedRecoveryException = params.isRecovery === true && latestPayment.status === "settlement_pending" && canonicalA2UTxid && latestPayment.a2uTxid === latestPayment.a2uPreparedTxHash && latestPayment.horizonSuccessFlag === true && latestPayment.piCompletionPending === true && latestPayment.piCompleted !== true && canonicalPreparedEnvelope && canonicalPreparedHash && canonicalPreparedSequence
      if (
        (!preparedRecoveryException && !preparedPairAbsent && !preparedPairCanonical) ||
        (!preparedRecoveryException && latestPayment.a2uPreparedEnvelopeXdr !== undefined && (!canonicalPreparedEnvelope || latestPayment.a2uPreparedTxHash === undefined || latestPayment.a2uPreparedSequence === undefined || !canonicalPreparedHash || !canonicalPreparedSequence || latestPayment.a2uTxid !== latestPayment.a2uPreparedTxHash || latestPayment.status !== "settled_to_merchant")) ||
        (!preparedRecoveryException && latestPayment.a2uPreparedTxHash !== undefined && latestPayment.status !== "settled_to_merchant") ||
        (!preparedRecoveryException && latestPayment.a2uPreparedSequence !== undefined && latestPayment.status !== "settled_to_merchant") ||
        (!preparedRecoveryException && latestPayment.a2uPreparedTxHash !== undefined && latestPayment.a2uTxid !== latestPayment.a2uPreparedTxHash) ||
        (latestPayment.a2uPaymentId !== undefined && (!canonicalA2UPaymentId || !canonicalA2UTxid)) ||
        (latestPayment.a2uPaymentId === undefined && (latestPayment.a2uTxid !== undefined || (latestPayment.horizonSuccessFlag !== undefined && latestPayment.horizonSuccessFlag !== false)))
      ) {
        return { ok: false, status: 409, error: "Payment state could not be verified" }
      }
    }

    console.log("[A2U Locked Executor] Latest payment status:", latestPayment.status)

    if (params.recoveryOperation === "SETTLEMENT_CREATE") {
      const customerAmount = latestPayment.customerAmount
      const piPaymentId = latestPayment.piPaymentId
      const u2aTxid = latestPayment.u2aTxid
      const payerUid = latestPayment.payerUid
      const merchantUid = latestPayment.merchantUid
      const retryCount = latestPayment.retryCount
      const nextRetryAt = latestPayment.nextRetryAt
      if (
        params.isRecovery !== true ||
        latestPayment.status !== "paid_to_app" ||
        latestPayment.id !== paymentId ||
        typeof piPaymentId !== "string" || !piPaymentId.trim() || piPaymentId !== piPaymentId.trim() ||
        typeof u2aTxid !== "string" || !u2aTxid.trim() || u2aTxid !== u2aTxid.trim() ||
        typeof payerUid !== "string" || !payerUid.trim() || payerUid !== payerUid.trim() ||
        typeof merchantUid !== "string" || !merchantUid.trim() || merchantUid !== merchantUid.trim() ||
        typeof customerAmount !== "number" || !Number.isFinite(customerAmount) || customerAmount <= 0 ||
        latestPayment.settlementFailureState !== "retryable" ||
        typeof retryCount !== "number" || !Number.isInteger(retryCount) || retryCount <= 0 ||
        typeof nextRetryAt !== "string" || !nextRetryAt.trim() || nextRetryAt !== nextRetryAt.trim() || !Number.isFinite(Date.parse(nextRetryAt)) || Date.parse(nextRetryAt) > Date.now() ||
        latestPayment.a2uPaymentId !== undefined || latestPayment.a2uTxid !== undefined ||
        latestPayment.a2uPreparedTxHash !== undefined || latestPayment.a2uPreparedSequence !== undefined || latestPayment.a2uPreparedEnvelopeXdr !== undefined ||
        latestPayment.refundPaymentId !== undefined || latestPayment.refundTxid !== undefined ||
        (latestPayment.refundStatus !== undefined && latestPayment.refundStatus !== "not_started") ||
        (latestPayment.horizonSuccessFlag !== undefined && latestPayment.horizonSuccessFlag !== false) ||
        (latestPayment.piCompletionPending !== undefined && latestPayment.piCompletionPending !== false) ||
        (latestPayment.piCompleted !== undefined && latestPayment.piCompleted !== false) ||
        (latestPayment.dbRecorded !== undefined && latestPayment.dbRecorded !== false) ||
        (latestPayment.requiresDbReconciliation !== undefined && latestPayment.requiresDbReconciliation !== false)
      ) {
        return { ok: false, status: 409, error: "Settlement create prerequisites could not be verified" }
      }

      const read = await readSettlementCreatePiEvidence(piPaymentId)
      const readBinding = evaluateFinancialRecoverySettlementCreateReadBinding({
        read,
        decisionInput: {
          paymentId,
          currentState: "app_funds_confirmed",
          targetState: "settlement_created",
          reconciliationOutcome: "NOT_ATTEMPTED",
          reconciliationSource: null,
          prerequisitesConfirmed: true,
          targetPaymentIdPresent: false,
          targetTxidPresent: false,
          targetMoneyMovementProof: null,
          malformed: false,
          multipleCandidates: false,
          unknown: [],
          missing: [],
          conflicts: [],
        },
        expected: { paymentId, piPaymentId, u2aTxid, amount: customerAmount, payerUid, merchantUid },
        queriedPaymentId: paymentId,
        refundCheckpoint: refundLookup,
      })
      if (readBinding.outcome !== "BOUND" || readBinding.result.outcome !== "GATE_RESULT" || readBinding.result.gate.allow !== true) {
        return { ok: false, status: 409, error: "Settlement create proof could not be verified" }
      }
    }

    if (params.recoveryOperation === "SETTLEMENT_SUBMIT") {
      if (params.isRecovery !== true || latestPayment.id !== paymentId) {
        return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
      }
      const walletLock = await acquirePiWalletSubmitLock(latestPayment.a2uFromAddress)
      if (!walletLock) {
        return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
      }
      try {
        const replay = await executeFinancialRecoverySettlementSubmitReplay({ payment: latestPayment, paymentId })
        if (replay.outcome === "MOVEMENT_VERIFIED") {
          if (
            replay.moneyMovementProven !== true ||
            replay.authorizesFinancialAction !== false ||
            replay.paymentId !== paymentId ||
            replay.merchantUid !== latestPayment.merchantUid ||
            replay.reference.preparedHash !== latestPayment.a2uPreparedTxHash ||
            replay.reference.preparedSequence !== latestPayment.a2uPreparedSequence ||
            replay.reference.a2uPaymentId !== latestPayment.a2uPaymentId ||
            replay.reference.fromAddress !== latestPayment.a2uFromAddress ||
            replay.reference.toAddress !== latestPayment.a2uToAddress ||
            replay.reference.amount !== latestPayment.merchantAmount ||
            replay.reference.envelopeXdr !== latestPayment.a2uPreparedEnvelopeXdr ||
            !Number.isFinite(replay.horizonFeeCharged) ||
            replay.horizonFeeCharged < 0
          ) {
            return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
          }
          try {
            await persistCheckpointMerged(paymentId, {
              a2uTxid: replay.reference.preparedHash,
              horizonSuccessFlag: true,
              horizonSuccessAt: new Date().toISOString(),
              status: "settlement_pending",
              horizonFeeCharged: replay.horizonFeeCharged,
              piCompletionPending: true,
            })
          } catch {
            return { ok: false, status: 500, error: "Settlement movement checkpoint persistence failed" }
          }
          return { ok: false, status: 409, error: "Settlement movement verified; reconciliation is not wired" }
        }
        if (replay.outcome !== "ALLOW_EXACT_REPLAY" || replay.mode !== "EXACT_STORED_XDR_ONLY" || replay.authorizesFinancialAction !== true) {
          return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
        }
        if (
          replay.paymentId !== latestPayment.id ||
          replay.merchantUid !== latestPayment.merchantUid ||
          replay.reference.paymentId !== latestPayment.id ||
          replay.reference.merchantUid !== latestPayment.merchantUid ||
          replay.reference.a2uPaymentId !== latestPayment.a2uPaymentId ||
          replay.reference.fromAddress !== latestPayment.a2uFromAddress ||
          replay.reference.toAddress !== latestPayment.a2uToAddress ||
          replay.reference.amount !== latestPayment.merchantAmount ||
          replay.reference.envelopeXdr !== latestPayment.a2uPreparedEnvelopeXdr ||
          replay.reference.preparedHash !== latestPayment.a2uPreparedTxHash ||
          replay.reference.preparedSequence !== latestPayment.a2uPreparedSequence
        ) {
          return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
        }
        try {
          const transaction = StellarSDK.TransactionBuilder.fromXDR(replay.reference.envelopeXdr, "Pi Testnet")
          if (
            !(transaction instanceof StellarSDK.Transaction) ||
            transaction.toXDR() !== latestPayment.a2uPreparedEnvelopeXdr ||
            transaction.hash().toString("hex") !== latestPayment.a2uPreparedTxHash ||
            transaction.sequence !== latestPayment.a2uPreparedSequence ||
            transaction.source !== latestPayment.a2uFromAddress
          ) {
            return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
          }
          const horizon = new StellarSDK.Horizon.Server("https://horizon-testnet.stellar.org")
          const submitted = await horizon.submitTransaction(transaction)
          if (submitted.hash !== latestPayment.a2uPreparedTxHash) {
            return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
          }
        } catch {
          return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
        }
        const verifiedReplay = await executeFinancialRecoverySettlementSubmitReplay({ payment: latestPayment, paymentId })
        if (
          verifiedReplay.outcome !== "MOVEMENT_VERIFIED" ||
          verifiedReplay.paymentId !== latestPayment.id ||
          verifiedReplay.merchantUid !== latestPayment.merchantUid ||
          verifiedReplay.reference.paymentId !== latestPayment.id ||
          verifiedReplay.reference.merchantUid !== latestPayment.merchantUid ||
          verifiedReplay.reference.a2uPaymentId !== latestPayment.a2uPaymentId ||
          verifiedReplay.reference.fromAddress !== latestPayment.a2uFromAddress ||
          verifiedReplay.reference.toAddress !== latestPayment.a2uToAddress ||
          verifiedReplay.reference.amount !== latestPayment.merchantAmount ||
          verifiedReplay.reference.envelopeXdr !== latestPayment.a2uPreparedEnvelopeXdr ||
          verifiedReplay.reference.preparedHash !== latestPayment.a2uPreparedTxHash ||
          verifiedReplay.reference.preparedSequence !== latestPayment.a2uPreparedSequence ||
          !Number.isFinite(verifiedReplay.horizonFeeCharged) ||
          verifiedReplay.horizonFeeCharged < 0
        ) {
          return { ok: false, status: 409, error: "Settlement submit proof could not be verified" }
        }
        try {
          await persistCheckpointMerged(paymentId, {
            a2uTxid: verifiedReplay.reference.preparedHash,
            horizonSuccessFlag: true,
            horizonSuccessAt: new Date().toISOString(),
            status: "settlement_pending",
            horizonFeeCharged: verifiedReplay.horizonFeeCharged,
            piCompletionPending: true,
          })
        } catch {
          return { ok: false, status: 500, error: "Settlement movement checkpoint persistence failed" }
        }
        return { ok: false, status: 409, error: "Settlement movement verified; reconciliation is not wired" }
      } finally {
        await walletLock.release()
      }
    }

    // Validate and derive all fields from LATEST checkpoint (not stale caller copies)
    if (!latestPayment.merchantUid || typeof latestPayment.merchantUid !== "string") {
      console.error("[A2U Locked Executor] Invalid merchantUid in latest checkpoint")
      return { ok: false, status: 400, error: "Invalid payment record" }
    }

    if (!latestPayment.accessToken || typeof latestPayment.accessToken !== "string") {
      console.error("[A2U Locked Executor] Invalid accessToken in latest checkpoint")
      return { ok: false, status: 400, error: "Invalid payment record" }
    }

    if (typeof latestPayment.amount !== "number" || latestPayment.amount <= 0) {
      console.error("[A2U Locked Executor] Invalid amount in latest checkpoint:", latestPayment.amount)
      return { ok: false, status: 400, error: "Invalid payment amount" }
    }

    if (!latestPayment.piPaymentId || typeof latestPayment.piPaymentId !== "string") {
      console.error("[A2U Locked Executor] Invalid piPaymentId in latest checkpoint")
      return { ok: false, status: 400, error: "Invalid payment record" }
    }

    const safetyState = latestPayment.settlementFailureState
    if (
      latestPayment.refundPaymentId || latestPayment.refundTxid ||
      latestPayment.refundStatus === "pending" || latestPayment.refundStatus === "submitted" ||
      latestPayment.refundStatus === "completed" || latestPayment.refundStatus === "manual_review_required" ||
      latestPayment.status === "refund_pending" || latestPayment.status === "refunded" ||
      safetyState === "held" || safetyState === "manual_review_required" ||
      safetyState === "refund_pending" || safetyState === "refunded"
    ) {
      return { ok: false, status: 409, error: "Refund operation owns this payment" }
    }

    if (
      latestPayment.status === "paid_to_app" &&
      safetyState === "retryable" &&
      latestPayment.nextRetryAt &&
      Date.parse(latestPayment.nextRetryAt) > Date.now()
    ) {
      return { ok: false, status: 409, error: "Settlement retry backoff is active" }
    }

    // Inside lock: any valid a2uTxid or horizonSuccessFlag must permanently skip Stage 2
    if (latestPayment.a2uTxid || latestPayment.horizonSuccessFlag) {
      console.log("[A2U Locked Executor] Valid a2uTxid or horizonSuccessFlag exists - will skip Stage 2")
    }

    // Execute A2U with derived fields from latest authoritative checkpoint
    // CRITICAL: executeA2U will throw on checkpoint persistence failure - catch and return error
    try {
      const result = await executeA2U({
        paymentId,
        payment: latestPayment,
        merchantUid: latestPayment.merchantUid,
        accessToken: latestPayment.accessToken,
        customerAmount: typeof latestPayment.customerAmount === "number" && Number.isFinite(latestPayment.customerAmount)
          ? latestPayment.customerAmount
          : latestPayment.amount,
        piPaymentId: latestPayment.piPaymentId,
        isRecovery: params.isRecovery,
        ...(params.recoveryOperation ? { recoveryOperation: params.recoveryOperation } : {}),
      })

      // Map executor result string status to numeric HTTP status code
      if (result.ok) {
        return { ok: true, status: 200 }
      } else {
        // Error case - map string status values to numeric HTTP codes
        let httpStatus: number = 400
        if (result.status === "404") {
          httpStatus = 404
        } else if (result.status === "500") {
          httpStatus = 500
        } else if (result.status === "400") {
          httpStatus = 400
        } else {
          httpStatus = 400 // Default for unknown statuses
        }
        return { ok: false, status: httpStatus, error: result.error }
      }
    } catch (executeError) {
      console.error("[A2U Locked Executor] Executor threw error (checkpoint persistence failed):", executeError)
      // Return error state - never proceed after checkpoint failure
      return { ok: false, status: 500, error: executeError instanceof Error ? executeError.message : String(executeError) }
    }
  } finally {
    await releaseLockAtomic()
  }
}
