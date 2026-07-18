import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2U } from "@/lib/a2u-executor"
import type { Payment } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/pi/complete
 * 
 * Client-facing endpoint that completes U2A payment verification from Pi.
 * Receives Pi payment identifier and txid from Pi Wallet callback.
 * 
 * MINIMAL FLOW:
 * 1. Verify U2A payment from Pi API (validation only)
 * 2. Persist status = paid_to_app to Redis
 * 3. Call unified executor to handle all A2U settlement stages
 * 4. Re-read latest payment state from Redis
 * 5. Return canonical response
 * 
 * All settlement, financial, and DB logic delegated to lib/a2u-executor.ts
 * Never returns early on a2uTxid - executor handles resumption
 * Never overwrites stale payment state over newer checkpoint
 */
export async function POST(request: NextRequest) {
  console.log("[Pi Complete] Request received at", new Date().toISOString())

  try {
    // Fail closed: require A2U_INTERNAL_SECRET from environment
    if (!serverConfig.a2uInternalSecret || typeof serverConfig.a2uInternalSecret !== "string") {
      console.error("[Pi Complete] SECURITY: A2U_INTERNAL_SECRET not configured - REJECTING")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    if (!serverConfig.isPiApiKeyConfigured) {
      console.error("[Pi Complete] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    // Parse request - accept ONLY piPaymentId + txid from client
    const body = await request.json()
    const { piPaymentId, txid } = body

    if (!piPaymentId || !txid) {
      console.error("[Pi Complete] Missing piPaymentId or txid")
      return NextResponse.json({ error: "Missing piPaymentId or txid" }, { status: 400 })
    }

    console.log("[Pi Complete] Processing Pi payment:", piPaymentId, "txid:", txid)

    // === STAGE 1: U2A VERIFICATION (validation only, no state changes) ===
    console.log("[Pi Complete] === STAGE 1: U2A VERIFICATION ===")

    const piResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
      method: "GET",
      headers: {
        "Authorization": `Key ${serverConfig.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!piResponse.ok) {
      console.error("[Pi Complete] Pi API verification failed - status:", piResponse.status)
      return NextResponse.json({ error: "Payment verification failed" }, { status: 400 })
    }

    const piPayment = await piResponse.json()

    // Validate payment structure
    if (!piPayment.identifier || piPayment.identifier !== piPaymentId) {
      console.error("[Pi Complete] Payment identifier mismatch")
      return NextResponse.json({ error: "Payment identifier mismatch" }, { status: 400 })
    }

    if (piPayment.direction !== "user_to_app") {
      console.error("[Pi Complete] Invalid payment direction:", piPayment.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    if (piPayment.status?.cancelled === true || piPayment.status?.user_cancelled === true) {
      console.error("[Pi Complete] Payment was cancelled")
      return NextResponse.json({ error: "Payment was cancelled" }, { status: 400 })
    }

    if (piPayment.status?.developer_approved !== true) {
      console.error("[Pi Complete] Developer did not approve payment")
      return NextResponse.json({ error: "Payment not approved" }, { status: 400 })
    }

    if (piPayment.status?.transaction_verified !== true) {
      console.error("[Pi Complete] Transaction not verified by Pi")
      return NextResponse.json({ error: "Transaction not verified" }, { status: 400 })
    }

    const canonicalTxid = piPayment.transaction?.txid
    if (!canonicalTxid || canonicalTxid !== txid) {
      console.error("[Pi Complete] Transaction txid mismatch or missing")
      return NextResponse.json({ error: "Transaction verification failed" }, { status: 400 })
    }

    // Derive paymentId from metadata (never trust client)
    const paymentId = piPayment.metadata?.paymentId
    if (!paymentId || typeof paymentId !== "string") {
      console.error("[Pi Complete] Invalid payment metadata - missing paymentId")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    console.log("[Pi Complete] ✅ U2A verification passed - paymentId:", paymentId)

    // === STAGE 2: Persist paid_to_app status ===
    console.log("[Pi Complete] === STAGE 2: Persist paid_to_app ===")

    // Load current payment state
    const currentCheckpoint = await redis.get(`payment:${paymentId}`)
    if (!currentCheckpoint) {
      console.error("[Pi Complete] Payment not found in Redis")
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    const payment: Payment = typeof currentCheckpoint === "string" ? JSON.parse(currentCheckpoint) : currentCheckpoint
    
    // Validate merchantUid and piPaymentId before executor
    if (!payment.merchantUid || typeof payment.merchantUid !== "string") {
      console.error("[Pi Complete] Payment missing merchantUid")
      return NextResponse.json({ error: "Invalid payment - missing merchantUid" }, { status: 400 })
    }
    if (!payment.piPaymentId || typeof payment.piPaymentId !== "string") {
      console.error("[Pi Complete] Payment missing piPaymentId")
      return NextResponse.json({ error: "Invalid payment - missing piPaymentId" }, { status: 400 })
    }
    
    // Persist paid_to_app status - this marks U2A complete
    payment.status = "paid_to_app"
    payment.u2aTxid = txid
    payment.paidAt = new Date().toISOString()
    
    // Ensure piPaymentId is persisted (may have come from client callback)
    if (!payment.piPaymentId && piPaymentId) {
      payment.piPaymentId = piPaymentId
    }
    
    await redis.set(`payment:${paymentId}`, JSON.stringify(payment))
    console.log("[Pi Complete] ✓ Persisted status = paid_to_app with paidAt timestamp")

    // === STAGE 3: Call unified executor ===
    console.log("[Pi Complete] === STAGE 3: Call unified executor ===")

    const executorResult = await executeA2U({
      paymentId,
      payment,
      merchantUid: payment.merchantUid,
      accessToken: payment.accessToken || "",
      customerAmount: payment.customerAmount || payment.amount,
      piPaymentId: payment.piPaymentId,
      isRecovery: false,
    })

    // Executor always returns success: false; check status/error instead
    if (executorResult.status === "error" || executorResult.error) {
      console.warn("[Pi Complete] Executor returned error - status:", executorResult.status, "error:", executorResult.error)
      // Still return success for client - settlement is async
    } else {
      console.log("[Pi Complete] ✓ Executor stages complete - status:", executorResult.status)
    }

    // === STAGE 4: Re-read latest checkpoint from Redis ===
    console.log("[Pi Complete] === STAGE 4: Re-read latest checkpoint ===")

    const latestCheckpoint = await redis.get(`payment:${paymentId}`)
    if (!latestCheckpoint) {
      console.error("[Pi Complete] Payment disappeared from Redis after executor")
      return NextResponse.json({ error: "Payment state lost" }, { status: 500 })
    }

    const latestPayment: Payment = typeof latestCheckpoint === "string" ? JSON.parse(latestCheckpoint) : latestCheckpoint
    console.log("[Pi Complete] ✓ Re-read latest checkpoint - status:", latestPayment.status)

    // === STAGE 5: Return canonical response ===
    console.log("[Pi Complete] === STAGE 5: Return canonical response ===")

    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      console.error("[Pi Complete] Failed to build canonical response")
      return NextResponse.json({ error: "Response building failed" }, { status: 500 })
    }

    console.log("[Pi Complete] ✅ Returning canonical response - final status:", latestPayment.status)
    return NextResponse.json(canonicalResponse, { status: 200 })
  } catch (error) {
    console.error("[Pi Complete] Exception:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
