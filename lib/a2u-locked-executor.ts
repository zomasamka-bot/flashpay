import { redis, isRedisConfigured } from "@/lib/redis"
import { executeA2U } from "@/lib/a2u-executor"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import type { Payment } from "@/lib/types"
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
  const lockKey = `a2u:lock:${paymentId}`
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

    const latestPayment: Payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

    console.log("[A2U Locked Executor] Latest payment status:", latestPayment.status)

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
        customerAmount: latestPayment.amount,
        piPaymentId: latestPayment.piPaymentId,
        isRecovery: params.isRecovery,
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
