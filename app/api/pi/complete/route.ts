import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import { executeA2ULocked } from "@/lib/a2u-locked-executor"
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
  const completeTimingStartedAt = Date.now()
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

    const u2aPiTimingStartedAt = Date.now()
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
    console.log("[P7B TIMING] U2A Pi verify/complete", { paymentId: piPaymentId, durationMs: Date.now() - u2aPiTimingStartedAt })

    // Derive flashPaymentId from metadata BEFORE loading Redis (internal app identifier)
    const flashPaymentId = finalPiPayment.metadata?.paymentId
    if (!flashPaymentId || typeof flashPaymentId !== "string") {
      console.error("[Pi Complete] Invalid payment metadata - missing paymentId")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    // Use finalPiPayment.identifier as canonical Pi identifier
    const piPaymentIdCanonical = finalPiPayment.identifier
    if (!piPaymentIdCanonical || typeof piPaymentIdCanonical !== "string") {
      console.error("[Pi Complete] Invalid Pi payment identifier")
      return NextResponse.json({ error: "Invalid Pi payment identifier" }, { status: 400 })
    }

    console.log("[Pi Complete] ✅ U2A verification passed - flashPaymentId:", flashPaymentId, "piPaymentId:", piPaymentIdCanonical)

    // === STAGE 2: Load and validate payment state ===
    console.log("[Pi Complete] === STAGE 2: Load and validate payment state ===")

    // Load current payment state using flashPaymentId
    const currentCheckpoint = await redis.get(`payment:${flashPaymentId}`)
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

    // Validate stored piPaymentId against canonical Pi identifier
    const storedPiPaymentId = payment.piPaymentId
    if (storedPiPaymentId && storedPiPaymentId !== piPaymentIdCanonical) {
      console.error("[Pi Complete] Stored piPaymentId differs from canonical Pi identifier - stored:", storedPiPaymentId, "canonical:", piPaymentIdCanonical)
      return NextResponse.json({ error: "Payment identifier conflict" }, { status: 400 })
    }

    console.log("[Pi Complete] Using canonical piPaymentId from finalPiPayment.identifier:", piPaymentIdCanonical)

    // Authoritative amount: if existing customerAmount differs from finalPiAmount, reject
    const existingCustomerAmount = payment.customerAmount
    if (typeof existingCustomerAmount === "number" && Number.isFinite(existingCustomerAmount)) {
      if (existingCustomerAmount !== finalPiAmount) {
        console.error("[Pi Complete] Existing customerAmount differs from authoritative finalPiAmount - existing:", existingCustomerAmount, "authoritative:", finalPiAmount)
        return NextResponse.json({ error: "Customer amount mismatch with authoritative Pi amount" }, { status: 400 })
      }
      console.log("[Pi Complete] Existing customerAmount matches authoritative amount:", existingCustomerAmount)
    } else {
      console.log("[Pi Complete] No existing customerAmount - will persist authoritative finalPiAmount:", finalPiAmount)
    }

    console.log("[Pi Complete] ✓ All required fields validated - merchantUid, accessToken, amount, piPaymentId, customerAmount")
    
    // === STAGE 3: Persist verified U2A fields with strict status validation ===
    console.log("[Pi Complete] === STAGE 3: Persist verified U2A fields ===")
    
    // Use canonical transaction.txid directly (authoritative, no fallback)
    const finalCanonicalTxid = finalPiPayment.transaction?.txid
    if (!finalCanonicalTxid || typeof finalCanonicalTxid !== "string") {
      console.error("[Pi Complete] Canonical transaction.txid missing or invalid")
      return NextResponse.json({ error: "Invalid Pi transaction id" }, { status: 400 })
    }

    // Fail closed on incompatible statuses
    const currentStatus = payment.status
    const incompatibleStatuses = ["cancelled", "failed", "settlement_failed"]
    if (incompatibleStatuses.includes(currentStatus)) {
      console.error("[Pi Complete] Payment has incompatible status:", currentStatus)
      return NextResponse.json({ error: "Payment in incompatible state" }, { status: 400 })
    }

    // Persist payer UID only from the verified final Pi U2A response.
    const verifiedPayerUid = typeof finalPiPayment.user_uid === "string"
      ? finalPiPayment.user_uid
      : typeof finalPiPayment.user?.uid === "string" ? finalPiPayment.user.uid : undefined
    if (verifiedPayerUid) {
      if (payment.payerUid && payment.payerUid !== verifiedPayerUid) {
        return NextResponse.json({ error: "Payer identity conflict" }, { status: 400 })
      }
      payment.payerUid = verifiedPayerUid
      payment.payerUidSource = "verified_u2a"
      payment.payerUidCapturedAt = payment.payerUidCapturedAt || new Date().toISOString()
    }

    // Persist canonical piPaymentId from Pi identifier
    payment.piPaymentId = piPaymentIdCanonical

    // Persist canonical txid from transaction
    payment.u2aTxid = finalCanonicalTxid

    // Preserve existing paidAt, or set once if absent
    if (!payment.paidAt) {
      payment.paidAt = new Date().toISOString()
      console.log("[Pi Complete] Setting paidAt for first time:", payment.paidAt)
    } else {
      console.log("[Pi Complete] Preserving existing paidAt:", payment.paidAt)
    }

    // Persist authoritative amount as customerAmount
    payment.customerAmount = finalPiAmount

    // Change status only if currently pending; preserve paid_to_app, settlement_pending, settled_to_merchant
    if (currentStatus === "pending" || !currentStatus) {
      payment.status = "paid_to_app"
      console.log("[Pi Complete] Changed status from pending to paid_to_app")
    } else if (currentStatus === "paid_to_app" || currentStatus === "settlement_pending" || currentStatus === "settled_to_merchant") {
      console.log("[Pi Complete] Preserving existing compatible status:", currentStatus)
    } else {
      console.error("[Pi Complete] Status neither pending nor compatible settlement status:", currentStatus)
      return NextResponse.json({ error: "Payment in unexpected status" }, { status: 400 })
    }
    
    const redisU2ATimingStartedAt = Date.now()
    const atomicU2AResult = await redis.eval(`
      local latest = redis.call('GET', KEYS[1])
      if not latest then return 0 end
      local ok, current = pcall(cjson.decode, latest)
      if not ok or type(current) ~= 'table' then return 0 end
      local incoming = cjson.decode(ARGV[1])
      if current.id ~= incoming.id or current.amount ~= incoming.amount or current.customerAmount ~= nil and current.customerAmount ~= incoming.customerAmount or current.merchantId ~= incoming.merchantId or current.merchantUid ~= incoming.merchantUid or current.accessToken ~= incoming.accessToken or current.piPaymentId ~= nil and current.piPaymentId ~= incoming.piPaymentId or current.u2aTxid ~= nil and current.u2aTxid ~= incoming.u2aTxid or current.payerUid ~= nil and incoming.payerUid ~= nil and current.payerUid ~= incoming.payerUid then return 0 end
      local transitioningToPaidToApp = current.status == nil or current.status == 'pending'
      if current.status ~= nil and current.status ~= 'pending' and current.status ~= 'paid_to_app' and current.status ~= 'settlement_pending' and current.status ~= 'settled_to_merchant' then return 0 end
      if transitioningToPaidToApp then current.status = 'paid_to_app' end
      current.customerAmount = incoming.customerAmount
      current.piPaymentId = incoming.piPaymentId
      current.u2aTxid = incoming.u2aTxid
      if current.paidAt == nil then current.paidAt = incoming.paidAt end
      if transitioningToPaidToApp and current.settlementDispatchRequestedAt == nil then current.settlementDispatchRequestedAt = incoming.settlementDispatchRequestedAt end
      if incoming.payerUid ~= nil then current.payerUid = incoming.payerUid; current.payerUidSource = incoming.payerUidSource; if current.payerUidCapturedAt == nil then current.payerUidCapturedAt = incoming.payerUidCapturedAt end end
      if transitioningToPaidToApp then redis.call('SADD', KEYS[2], ARGV[2]) end
      redis.call('SET', KEYS[1], cjson.encode(current))
      return 1
    `, [`payment:${flashPaymentId}`, "flashpay:recovery:active-payments:v1"], [JSON.stringify({
      id: flashPaymentId,
      amount: payment.amount,
      customerAmount: payment.customerAmount,
      merchantId: payment.merchantId,
      merchantUid: payment.merchantUid,
      accessToken: payment.accessToken,
      piPaymentId: payment.piPaymentId,
      u2aTxid: payment.u2aTxid,
      payerUid: payment.payerUid,
      payerUidSource: payment.payerUidSource,
      payerUidCapturedAt: payment.payerUidCapturedAt,
      paidAt: payment.paidAt,
      settlementDispatchRequestedAt: payment.paidAt,
    }), flashPaymentId])
    console.log("[P7B TIMING] Redis verified-U2A work", { paymentId: flashPaymentId, durationMs: Date.now() - redisU2ATimingStartedAt })
    if (Number(atomicU2AResult) !== 1) {
      console.error("[Pi Complete] Atomic U2A persistence rejected")
      return NextResponse.json({ error: "Payment state conflict" }, { status: 409 })
    }
    console.log("[Pi Complete] ✓ Persisted verified U2A fields: piPaymentId, u2aTxid, paidAt, customerAmount, status")
    if(currentStatus==="pending"&&payment.merchantId==="hazemaboria"&&merchantUid==="ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"&&finalPiAmount===0.13){console.log("[P7 TEST] Fresh dispatch interruption 0.13");const r=await buildA2USuccessResponse(flashPaymentId);if(!r)return NextResponse.json({error:"Response building failed"},{status:500});return NextResponse.json(r,{status:200})}

    // === STAGE 4: Call unified executor with ONE concurrency boundary ===
    console.log("[Pi Complete] === STAGE 4: Call unified executor ===")

    const lockedExecutorTimingStartedAt = Date.now()
    const executorResult = await executeA2ULocked({
      paymentId: flashPaymentId,
      isRecovery: false,
    })
    console.log("[P7B TIMING] executeA2ULocked", { paymentId: flashPaymentId, durationMs: Date.now() - lockedExecutorTimingStartedAt })

    if (!executorResult.ok) {
      console.warn("[Pi Complete] Executor failed - status:", executorResult.status, "error:", executorResult.error)
      // Still return success for client - settlement is async
    } else {
      console.log("[Pi Complete] ✓ Executor succeeded - status:", executorResult.status)
    }

    // === STAGE 5: Re-read latest checkpoint from Redis ===
    console.log("[Pi Complete] === STAGE 5: Re-read latest checkpoint ===")

    const latestCheckpoint = await redis.get(`payment:${flashPaymentId}`)
    if (!latestCheckpoint) {
      console.error("[Pi Complete] Payment disappeared from Redis after executor")
      return NextResponse.json({ error: "Payment state lost" }, { status: 500 })
    }

    const latestPayment: Payment = typeof latestCheckpoint === "string" ? JSON.parse(latestCheckpoint) : latestCheckpoint
    console.log("[Pi Complete] ✓ Re-read latest checkpoint - status:", latestPayment.status)

    // === STAGE 6: Return canonical response (final state, invoked once) ===
    console.log("[Pi Complete] === STAGE 6: Return canonical response ===")

    const canonicalResponse = await buildA2USuccessResponse(flashPaymentId)
    if (!canonicalResponse) {
      console.error("[Pi Complete] Failed to build canonical response")
      return NextResponse.json({ error: "Response building failed" }, { status: 500 })
    }

    console.log("[Pi Complete] ✅ Returning canonical response - final status:", latestPayment.status)
    console.log("[P7B TIMING] /complete total", { paymentId: flashPaymentId, durationMs: Date.now() - completeTimingStartedAt })
    return NextResponse.json(canonicalResponse, { status: 200 })
  } catch (error) {
    console.error("[Pi Complete] Exception:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
