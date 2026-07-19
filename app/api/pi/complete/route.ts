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
 * AUTHORITATIVE U2A COMPLETION FLOW:
 * 1. Verify U2A payment from Pi API (validation only)
 * 2. If not developer_completed, call Pi /v2/payments/{piPaymentId}/complete, then refetch and validate
 * 3. Load and validate all required fields (merchantUid validated before any A2U execution)
 * 4. Persist status = paid_to_app to Redis (never overwrites settlement_pending or settled_to_merchant)
 * 5. Call unified executor once to handle all A2U settlement stages
 * 6. Re-read latest payment state from Redis
 * 7. Return canonical response (final state)
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

    // If not developer_completed, call Pi /complete endpoint and refetch
    let finalPiPayment = piPayment
    if (piPayment.status?.developer_completed !== true) {
      console.log("[Pi Complete] Payment not developer_completed - calling Pi /complete endpoint")
      
      const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}/complete`, {
        method: "POST",
        headers: {
          "Authorization": `Key ${serverConfig.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      })

      if (!completeResponse.ok) {
        console.error("[Pi Complete] Pi /complete call failed - status:", completeResponse.status)
        return NextResponse.json({ error: "Payment completion failed" }, { status: 400 })
      }

      // Refetch payment to validate developer_completed=true
      const refetchResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
        method: "GET",
        headers: {
          "Authorization": `Key ${serverConfig.piApiKey}`,
          "Content-Type": "application/json",
        },
      })

      if (!refetchResponse.ok) {
        console.error("[Pi Complete] Refetch after /complete failed - status:", refetchResponse.status)
        return NextResponse.json({ error: "Payment verification failed" }, { status: 400 })
      }

      finalPiPayment = await refetchResponse.json()

      // Validate identifier, direction, amount, txid, non-cancelled, developer_completed after refetch
      if (!finalPiPayment.identifier || finalPiPayment.identifier !== piPaymentId) {
        console.error("[Pi Complete] Refetched payment identifier mismatch")
        return NextResponse.json({ error: "Payment identifier mismatch" }, { status: 400 })
      }

      if (finalPiPayment.direction !== "user_to_app") {
        console.error("[Pi Complete] Refetched payment invalid direction:", finalPiPayment.direction)
        return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
      }

      if (finalPiPayment.status?.cancelled === true || finalPiPayment.status?.user_cancelled === true) {
        console.error("[Pi Complete] Refetched payment was cancelled")
        return NextResponse.json({ error: "Payment was cancelled" }, { status: 400 })
      }

      if (finalPiPayment.status?.developer_completed !== true) {
        console.error("[Pi Complete] Refetched payment still not developer_completed")
        return NextResponse.json({ error: "Payment completion failed" }, { status: 400 })
      }

      const refetchedTxid = finalPiPayment.transaction?.txid
      if (!refetchedTxid || refetchedTxid !== txid) {
        console.error("[Pi Complete] Refetched txid mismatch")
        return NextResponse.json({ error: "Transaction verification failed" }, { status: 400 })
      }

      console.log("[Pi Complete] ✓ Pi /complete succeeded and payment verified")
    } else {
      console.log("[Pi Complete] Payment already developer_completed - skipping Pi /complete call")
    }

    // Derive paymentId from metadata (never trust client)
    const paymentId = piPayment.metadata?.paymentId
    if (!paymentId || typeof paymentId !== "string") {
      console.error("[Pi Complete] Invalid payment metadata - missing paymentId")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    console.log("[Pi Complete] ✅ U2A verification passed - paymentId:", paymentId)

    // === STAGE 2: Load and validate payment state ===
    console.log("[Pi Complete] === STAGE 2: Load and validate payment state ===")

    // Load current payment state
    const currentCheckpoint = await redis.get(`payment:${paymentId}`)
    if (!currentCheckpoint) {
      console.error("[Pi Complete] Payment not found in Redis")
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    const payment: Payment = typeof currentCheckpoint === "string" ? JSON.parse(currentCheckpoint) : currentCheckpoint
    
    // Capture and validate all required fields BEFORE mutation (strict TypeScript contracts)
    // Validate merchantUid BEFORE any A2U execution
    const merchantUid = payment.merchantUid
    if (!merchantUid || typeof merchantUid !== "string") {
      console.error("[Pi Complete] Payment missing merchantUid")
      return NextResponse.json({ error: "Invalid payment - missing merchantUid" }, { status: 400 })
    }
    
    const accessToken = payment.accessToken
    if (!accessToken || typeof accessToken !== "string") {
      console.error("[Pi Complete] Payment missing accessToken")
      return NextResponse.json({ error: "Invalid payment - missing accessToken" }, { status: 400 })
    }
    
    // Validate finalPiPayment.amount is finite positive and matches Redis payment.amount
    const finalPiAmount = finalPiPayment.amount
    if (typeof finalPiAmount !== "number" || !Number.isFinite(finalPiAmount) || finalPiAmount <= 0) {
      console.error("[Pi Complete] Pi amount invalid - not finite or not positive:", finalPiAmount)
      return NextResponse.json({ error: "Invalid Pi payment amount" }, { status: 400 })
    }

    const redisAmount = payment.amount
    if (typeof redisAmount !== "number" || !Number.isFinite(redisAmount)) {
      console.error("[Pi Complete] Redis payment amount invalid:", redisAmount)
      return NextResponse.json({ error: "Invalid payment - invalid amount in Redis" }, { status: 400 })
    }

    if (finalPiAmount !== redisAmount) {
      console.error("[Pi Complete] Amount mismatch - Pi:", finalPiAmount, "Redis:", redisAmount)
      return NextResponse.json({ error: "Payment amount mismatch" }, { status: 400 })
    }

    // piPaymentId: use Redis value if present and matches canonical; otherwise use canonical
    let piPaymentIdToUse: string
    const existingPiPaymentId = payment.piPaymentId
    if (existingPiPaymentId && typeof existingPiPaymentId === "string") {
      if (existingPiPaymentId !== piPaymentId) {
        console.error("[Pi Complete] Existing piPaymentId differs from canonical - existing:", existingPiPaymentId, "canonical:", piPaymentId)
        return NextResponse.json({ error: "Payment identifier conflict" }, { status: 400 })
      }
      piPaymentIdToUse = existingPiPaymentId
      console.log("[Pi Complete] Using existing piPaymentId from Redis:", piPaymentIdToUse)
    } else {
      piPaymentIdToUse = piPaymentId
      console.log("[Pi Complete] Using canonical piPaymentId (not previously stored):", piPaymentIdToUse)
    }

    // customerAmount: use Redis value if present; otherwise use canonical
    let customerAmountToUse: number
    const existingCustomerAmount = payment.customerAmount
    if (typeof existingCustomerAmount === "number" && Number.isFinite(existingCustomerAmount)) {
      customerAmountToUse = existingCustomerAmount
      console.log("[Pi Complete] Using existing customerAmount from Redis:", customerAmountToUse)
    } else if (typeof finalPiAmount === "number" && Number.isFinite(finalPiAmount)) {
      customerAmountToUse = finalPiAmount
      console.log("[Pi Complete] Using canonical amount as customerAmount (not previously stored):", customerAmountToUse)
    } else {
      console.error("[Pi Complete] Unable to determine customerAmount")
      return NextResponse.json({ error: "Invalid payment - unable to determine customerAmount" }, { status: 400 })
    }

    console.log("[Pi Complete] ✓ All required fields validated - merchantUid, accessToken, amount, piPaymentId, customerAmount")
    
    // === STAGE 3: Persist verified U2A fields without overwriting newer settlement status ===
    console.log("[Pi Complete] === STAGE 3: Persist verified U2A fields ===")
    
    // Update ONLY verified U2A metadata and txid; preserve any newer settlement status
    const currentStatus = payment.status
    payment.piPaymentId = piPaymentIdToUse
    payment.u2aTxid = finalPiPayment.transaction?.txid || txid
    payment.paidAt = new Date().toISOString()
    payment.customerAmount = customerAmountToUse
    
    // If status is still paid_to_app (not yet advanced), it will be set by executor
    // If status is already settlement_pending or settled_to_merchant (executor already ran), preserve it
    if (currentStatus === "paid_to_app" || !currentStatus) {
      payment.status = "paid_to_app"
      console.log("[Pi Complete] Setting status = paid_to_app (U2A complete)")
    } else {
      console.log("[Pi Complete] Preserving existing status:", currentStatus, "(executor may have already advanced)")
    }
    
    await redis.set(`payment:${paymentId}`, JSON.stringify(payment))
    console.log("[Pi Complete] ✓ Persisted verified U2A fields: piPaymentId, u2aTxid, paidAt, customerAmount")

    // === STAGE 4: Call unified executor with validated fields (invoked once) ===
    console.log("[Pi Complete] === STAGE 4: Call unified executor ===")

    const executorResult = await executeA2U({
      paymentId,
      payment,
      merchantUid,
      accessToken,
      customerAmount: customerAmountToUse,
      piPaymentId: piPaymentIdToUse,
      isRecovery: false,
    })

    if (!executorResult.ok) {
      console.warn("[Pi Complete] Executor failed - status:", executorResult.status, "error:", executorResult.error)
      // Still return success for client - settlement is async
    } else {
      console.log("[Pi Complete] ✓ Executor succeeded - status:", executorResult.status)
    }

    // === STAGE 5: Re-read latest checkpoint from Redis ===
    console.log("[Pi Complete] === STAGE 5: Re-read latest checkpoint ===")

    const latestCheckpoint = await redis.get(`payment:${paymentId}`)
    if (!latestCheckpoint) {
      console.error("[Pi Complete] Payment disappeared from Redis after executor")
      return NextResponse.json({ error: "Payment state lost" }, { status: 500 })
    }

    const latestPayment: Payment = typeof latestCheckpoint === "string" ? JSON.parse(latestCheckpoint) : latestCheckpoint
    console.log("[Pi Complete] ✓ Re-read latest checkpoint - status:", latestPayment.status)

    // === STAGE 6: Return canonical response (final state, invoked once) ===
    console.log("[Pi Complete] === STAGE 6: Return canonical response ===")

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
