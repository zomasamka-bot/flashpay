import { type NextRequest, NextResponse } from "next/server"
import { serverConfig } from "@/lib/server-config"
import { redis, isRedisConfigured } from "@/lib/redis"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2U } from "@/lib/a2u-executor"
import type { Payment } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// STRICT: Accept ONLY paymentId. No merchant data, no amounts, no UIDs, no tokens.
// All authoritative data comes from verified Redis payment record.
interface A2UPaymentRequest {
  paymentId: string
}

// Validate request body contains ONLY paymentId, nothing else
function validateA2URequestBody(body: unknown): body is A2UPaymentRequest {
  if (!body || typeof body !== "object") return false

  const keys = Object.keys(body as Record<string, unknown>)

  // Must have exactly 1 key: paymentId
  if (keys.length !== 1) {
    console.error("[Pi A2U] SECURITY: Request body has", keys.length, "keys, expected exactly 1. Keys:", keys)
    return false
  }

  if (!keys.includes("paymentId")) {
    console.error("[Pi A2U] SECURITY: Request body missing paymentId. Keys:", keys)
    return false
  }

  const req = body as Record<string, unknown>
  const paymentId = req.paymentId

  if (typeof paymentId !== "string" || !paymentId) {
    console.error("[Pi A2U] SECURITY: paymentId is not a non-empty string")
    return false
  }

  return true
}

/**
 * ============================================================================
 * App-to-User Transfer (A2U) - Execute A2U via unified executor
 * ============================================================================
 *
 * MINIMAL ROUTE: Only handles authentication, lock, load, and delegates to executor.
 *
 * Accepts ONLY paymentId; delegates ALL A2U execution to lib/a2u-executor.ts
 * which is the ONLY A2U execution implementation.
 *
 * FLOW:
 * 1. Validate internal secret header (x-flashpay-internal-secret)
 * 2. Validate request contains ONLY paymentId
 * 3. Acquire distributed lock on payment:${paymentId}
 * 4. Load payment from Redis
 * 5. Call executeA2U() from lib/a2u-executor.ts
 * 6. Return canonical response
 */

// POST /api/pi/a2u — A2U endpoint (delegates to executor)
export async function POST(request: NextRequest) {
  console.log("[Pi A2U] A2U request initiated at", new Date().toISOString())

  let lockToken: string | null = null
  let lockKey: string | null = null
  let lockAcquired = false

  const releaseLockAtomic = async () => {
    if (!lockAcquired || !lockToken || !lockKey || !isRedisConfigured) return
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
      console.warn("[Pi A2U] Failed to release lock atomically:", error)
    }
  }

  try {
    // === AUTHENTICATION ===
    const providedSecret = request.headers.get("x-flashpay-internal-secret")

    if (!serverConfig.a2uInternalSecret || typeof serverConfig.a2uInternalSecret !== "string") {
      console.error("[Pi A2U] SECURITY: A2U_INTERNAL_SECRET not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    if (!providedSecret) {
      console.error("[Pi A2U] SECURITY: Missing x-flashpay-internal-secret header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Timing-safe comparison
    const secretBuffer = Buffer.from(serverConfig.a2uInternalSecret)
    const providedBuffer = Buffer.from(providedSecret)

    if (secretBuffer.length !== providedBuffer.length || !secretBuffer.equals(providedBuffer)) {
      console.error("[Pi A2U] SECURITY: Invalid x-flashpay-internal-secret header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log("[Pi A2U] ✓ Internal secret validated")

    if (!serverConfig.isPiApiKeyConfigured) {
      console.error("[Pi A2U] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    // === VALIDATE REQUEST ===
    let body: unknown
    try {
      body = await request.json()
    } catch (e) {
      console.error("[Pi A2U] Invalid JSON in request body")
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
    }

    if (!validateA2URequestBody(body)) {
      console.error("[Pi A2U] SECURITY: Request body validation failed")
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
    }

    const { paymentId } = body

    console.log("[Pi A2U] ===== A2U REQUEST RECEIVED =====")
    console.log("[Pi A2U] Payment ID:", paymentId)

    // === CONCURRENCY LOCK ===
    if (!isRedisConfigured) {
      console.error("[Pi A2U] Redis not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    lockToken = crypto.randomUUID()
    lockKey = `a2u:lock:${paymentId}`
    const lockTtl = 600 // 10 minutes

    console.log("[Pi A2U] ===== ACQUIRING CONCURRENCY LOCK =====")

    try {
      const lockResult = await redis.set(lockKey, lockToken, { nx: true, ex: lockTtl })
      lockAcquired = lockResult === "OK"
    } catch (lockError) {
      console.error("[Pi A2U] Lock acquisition error:", lockError)
    }

    if (!lockAcquired) {
      console.warn("[Pi A2U] Could not acquire lock - checking if already settled...")

      const paymentCheck = await redis.get(`payment:${paymentId}`)
      const payment = paymentCheck ? (typeof paymentCheck === "string" ? JSON.parse(paymentCheck) : paymentCheck) : null

      if (payment?.status === "settled_to_merchant") {
        console.log("[Pi A2U] Payment already settled - returning canonical response")
        const canonicalResponse = await buildA2USuccessResponse(paymentId)
        if (!canonicalResponse) {
          return NextResponse.json(
            { error: "Response building failed - data corruption detected" },
            { status: 500 }
          )
        }
        return NextResponse.json(canonicalResponse)
      }

      console.error("[Pi A2U] Lock unavailable and payment not complete - cannot proceed")
      return NextResponse.json({ error: "A2U transfer in progress" }, { status: 409 })
    }

    console.log("[Pi A2U] ✓ Lock acquired:", lockKey)

    // === LOAD PAYMENT ===
    const paymentData = await redis.get(`payment:${paymentId}`)

    if (!paymentData) {
      console.error("[Pi A2U] Payment not found in Redis:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    const payment: Payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

    // Check if already settled
    if (payment.status === "settled_to_merchant") {
      console.log("[Pi A2U] Payment already settled - returning canonical response")
      const canonicalResponse = await buildA2USuccessResponse(paymentId)
      if (!canonicalResponse) {
        return NextResponse.json(
          { error: "Response building failed - data corruption detected" },
          { status: 500 }
        )
      }
      return NextResponse.json(canonicalResponse)
    }

    console.log("[Pi A2U] ✓ Payment loaded from Redis")

    // === DELEGATE TO EXECUTOR ===
    console.log("[Pi A2U] Delegating to unified A2U executor")

    // Validate required fields for executor
    if (payment.status !== "paid_to_app") {
      console.error("[Pi A2U] Payment status is not paid_to_app:", payment.status)
      return NextResponse.json({ error: "Payment not in paid_to_app state" }, { status: 400 })
    }

    if (!payment.merchantUid) {
      console.error("[Pi A2U] Missing merchantUid")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.accessToken) {
      console.error("[Pi A2U] Missing accessToken")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.piPaymentId) {
      console.error("[Pi A2U] Missing piPaymentId")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (typeof payment.amount !== "number" || payment.amount <= 0) {
      console.error("[Pi A2U] Invalid payment amount:", payment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    // Call unified executor (always returns settlement_pending or error)
    const result = await executeA2U({
      paymentId,
      payment,
      merchantUid: payment.merchantUid,
      accessToken: payment.accessToken,
      customerAmount: payment.amount,
      piPaymentId: payment.piPaymentId,
      isRecovery: false,
    })

    if (result.status === "error" || result.error) {
      console.error("[Pi A2U] Executor error:", result.error)
      return NextResponse.json(
        { error: result.error || "A2U execution failed", success: false },
        { status: 400 }
      )
    }

    console.log("[Pi A2U] Executor stages complete - building canonical response via predicate check")

    // === ALWAYS INVOKE CANONICAL RESPONSE BUILDER ===
    // buildA2USuccessResponse() validates predicate and returns success: true/false
    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      console.error("[Pi A2U] Failed to build canonical response - data inconsistency")
      return NextResponse.json(
        { error: "Response building failed", success: false },
        { status: 500 }
      )
    }

    return NextResponse.json(canonicalResponse)
  } catch (error) {
    console.error("[Pi A2U] Unhandled exception:", error)
    return NextResponse.json(
      { error: "Internal server error", success: false },
      { status: 500 }
    )
  } finally {
    await releaseLockAtomic()
  }
}
