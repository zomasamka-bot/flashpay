import { type NextRequest, NextResponse } from "next/server"
import { serverConfig } from "@/lib/server-config"
import { redis, isRedisConfigured } from "@/lib/redis"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2ULocked } from "@/lib/a2u-locked-executor"
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
 * App-to-User Transfer (A2U) - Execute A2U via ONE shared locked boundary
 * ============================================================================
 *
 * MINIMAL ROUTE: Only handles authentication and delegates to executeA2ULocked.
 *
 * ALL A2U concurrency (routes /api/pi/a2u, /api/pi/complete, /api/recovery/[id])
 * flows through executeA2ULocked() with one Redis lock per paymentId.
 *
 * FLOW:
 * 1. Validate internal secret header (x-flashpay-internal-secret)
 * 2. Validate request contains ONLY paymentId
 * 3. Load payment from Redis (authoritative source)
 * 4. Call executeA2ULocked() (ONE concurrency boundary, handles all locking)
 * 5. Return canonical response
 */

// POST /api/pi/a2u — A2U endpoint (delegates to shared locked executor)
export async function POST(request: NextRequest) {
  console.log("[Pi A2U] A2U request initiated at", new Date().toISOString())

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

    if (!isRedisConfigured) {
      console.error("[Pi A2U] Redis not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    // === LOAD PAYMENT ===
    const paymentData = await redis.get(`payment:${paymentId}`)

    if (!paymentData) {
      console.error("[Pi A2U] Payment not found in Redis:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    const payment: Payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

    console.log("[Pi A2U] ✓ Payment loaded from Redis - status:", payment.status)

    // === DELEGATE TO SHARED LOCKED EXECUTOR ===
    console.log("[Pi A2U] Delegating to shared locked A2U executor (ONE concurrency boundary)")

    // Validate required fields for executor
    if (!payment.merchantUid) {
      console.error("[Pi A2U] Missing merchantUid")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!payment.accessToken) {
      console.error("[Pi A2U] Missing accessToken")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (typeof payment.amount !== "number" || payment.amount <= 0) {
      console.error("[Pi A2U] Invalid payment amount:", payment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    // Call shared locked executor with ONE concurrency boundary (handles all locking)
    const result = await executeA2ULocked({
      paymentId,
      payment,
      merchantUid: payment.merchantUid,
      accessToken: payment.accessToken,
      customerAmount: payment.amount,
      piPaymentId: payment.piPaymentId,
      isRecovery: false,
    })

    if (!result.ok) {
      console.error("[Pi A2U] Locked executor error:", result.error)
      return NextResponse.json(
        { error: result.error, success: false },
        { status: result.status || 400 }
      )
    }

    console.log("[Pi A2U] ✓ Locked executor succeeded - settlement stage initiated")

    // === RETURN CANONICAL RESPONSE ===
    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      return NextResponse.json(
        { error: "Response building failed - data corruption detected" },
        { status: 500 }
      )
    }

    return NextResponse.json(canonicalResponse)
  } catch (error) {
    console.error("[Pi A2U] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
