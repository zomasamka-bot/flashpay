import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordA2UTransactionAtomic } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
  }
  from_address: string
  to_address: string
  direction: string
  network: string
  created_at: string
  transaction: {
    txid: string
    verified: boolean
    _link: string
  }
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
}

// POST /api/pi/complete — Called by Pi SDK (onReadyForServerCompletion)
// 1. Validates Pi payment via server API key
// 2. Calls A2U to settle funds to merchant wallet
// 3. Records atomic transaction in DB ONLY when settlement succeeds
// 4. Returns SETTLED_TO_MERCHANT status to client for onSuccess
export async function POST(request: NextRequest) {
  console.log("[Pi Webhook] COMPLETE called at", new Date().toISOString())

  try {
    const body = await request.json()
    const identifier = body.identifier
    const clientTxid = body.transaction?.txid || body.txid

    if (!identifier) {
      console.error("[Pi Webhook] Missing identifier in request")
      return NextResponse.json({ error: "Missing identifier" }, { status: 400 })
    }
    if (!clientTxid) {
      console.error("[Pi Webhook] Missing txid in request")
      return NextResponse.json({ error: "Missing txid" }, { status: 400 })
    }

    console.log("[Pi Webhook] Identifier:", identifier)
    console.log("[Pi Webhook] Client Txid:", clientTxid)

    // Fetch canonical Pi payment using server API key
    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    console.log("[Pi Webhook] Fetching canonical Pi payment from Pi API...")
    const piPaymentResponse = await fetch(`https://api.minepi.com/v2/payments/${identifier}`, {
      method: "GET",
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!piPaymentResponse.ok) {
      console.error("[Pi Webhook] Failed to fetch Pi payment:", piPaymentResponse.status)
      return NextResponse.json({ error: "Failed to fetch Pi payment" }, { status: 400 })
    }

    const piPayment = await piPaymentResponse.json()
    console.log("[Pi Webhook] Pi payment fetched - metadata:", piPayment.metadata)

    // Use ONLY metadata.paymentId to load Redis
    const paymentId = piPayment.metadata?.paymentId
    if (!paymentId) {
      console.error("[Pi Webhook] No paymentId in Pi payment metadata")
      return NextResponse.json({ error: "Invalid Pi payment metadata" }, { status: 400 })
    }

    const paymentDTO: PiPaymentDTO = piPayment

    // Retrieve payment from Redis
    if (!isRedisConfigured) {
      console.error("[Pi Webhook] Redis not configured")
      return NextResponse.json({ error: "Redis not configured" }, { status: 500 })
    }

    const data = await redis.get(`payment:${paymentId}`)
    const existingPayment = data ? (typeof data === "string" ? JSON.parse(data) : data) : null

    if (!existingPayment) {
      console.error("[Pi Webhook] Payment not found in Redis:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    console.log("[Pi Webhook] Payment retrieved from Redis:", paymentId)

    // VERIFICATION CHECKS - validate Pi payment against Redis and Pi status
    const piStatus = paymentDTO.status
    const piTransaction = paymentDTO.transaction

    // Check: user_to_app
    if (paymentDTO.direction !== "user_to_app") {
      console.error("[Pi Webhook] Invalid direction:", paymentDTO.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    // Check: approved
    if (!piStatus.developer_approved) {
      console.error("[Pi Webhook] Payment not approved by developer")
      return NextResponse.json({ error: "Payment not approved" }, { status: 400 })
    }

    // Check: not cancelled
    if (piStatus.cancelled || piStatus.user_cancelled) {
      console.error("[Pi Webhook] Payment is cancelled")
      return NextResponse.json({ error: "Payment is cancelled" }, { status: 400 })
    }

    // Check: transaction verified
    if (!piTransaction.verified) {
      console.error("[Pi Webhook] Transaction not verified")
      return NextResponse.json({ error: "Transaction not verified" }, { status: 400 })
    }

    // Check: matching txid
    if (piTransaction.txid !== clientTxid) {
      console.error("[Pi Webhook] Txid mismatch - Pi:", piTransaction.txid, "Client:", clientTxid)
      return NextResponse.json({ error: "Txid mismatch" }, { status: 400 })
    }

    // Check: matching amount (trust Redis amount)
    if (paymentDTO.amount !== existingPayment.amount) {
      console.error("[Pi Webhook] Amount mismatch - Pi:", paymentDTO.amount, "Redis:", existingPayment.amount)
      return NextResponse.json({ error: "Amount mismatch" }, { status: 400 })
    }

    // Extract merchant data
    const merchantId = existingPayment.merchantId
    const merchantUid = existingPayment.merchantUid
    const createdAt = existingPayment.createdAt || new Date().toISOString()
    const parsedCreatedAt = new Date(createdAt)
    const createdAtDate = Number.isNaN(parsedCreatedAt.getTime()) ? new Date() : parsedCreatedAt

    if (!merchantId || typeof merchantId !== "string") {
      console.error("[Pi Webhook] No merchantId in Redis")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    // Check: Redis status is pending
    if (existingPayment.status !== "pending") {
      console.error("[Pi Webhook] Unexpected payment status:", existingPayment.status)
      return NextResponse.json({ error: "Unexpected payment status" }, { status: 400 })
    }

    // STEP 1: Mark as paid_to_app in Redis after Pi confirms
    const u2aIdentifier = identifier
    const u2aTxid = clientTxid

    const paidToAppPayment = {
      ...existingPayment,
      status: "paid_to_app" as const,
      paidAt: new Date().toISOString(),
      txid: clientTxid,
      piPaymentId: identifier,
      u2aIdentifier: u2aIdentifier,
      u2aTxid: u2aTxid,
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(paidToAppPayment))
    console.log("[Pi Webhook] ✓ Payment marked as PAID_TO_APP in Redis after Pi confirmation")

    // STEP 2: If merchantUid missing, stop here - cannot settle
    if (!merchantUid || typeof merchantUid !== "string") {
      console.warn("[Pi Webhook] ⚠️ Merchant UID missing - cannot perform A2U settlement")
      console.warn("[Pi Webhook] Payment marked PAID_TO_APP but requires manual merchant setup")
      return NextResponse.json({
        status: "paid_to_app",
        message: "Payment received but merchant wallet not configured",
      })
    }

    // STEP 3: Call A2U endpoint to initiate settlement
    console.log("[Pi Webhook] Initiating A2U settlement...")
    const a2uUrl = `${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000"}/api/pi/a2u`

    const a2uResponse = await fetch(a2uUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: paymentId,
        merchantUid: merchantUid,
        amount: existingPayment.amount,
        note: existingPayment.note || "Payment Settlement",
      }),
    })

    const a2uData = await a2uResponse.json()
    console.log("[Pi Webhook] A2U response:", a2uData)

    // STEP 4a: A2U PENDING - awaiting blockchain signing
    if (a2uResponse.status === 202 && (a2uData.status === "pending_signing" || a2uData.status === "pending_implementation" || a2uData.status === "reusing_ongoing")) {
      console.warn("[A2U-PENDING] ⏳ A2U awaiting blockchain signing")
      console.warn("[A2U-PENDING] A2U status:", a2uData.status)
      console.warn("[A2U-PENDING] Pi payment identifier:", a2uData.a2uPaymentId)

      // Store A2U identifiers atomically BEFORE Pi /complete completes
      // This is critical for retry logic - if Pi fails next, we have A2U info stored
      const settlementPendingPayment = {
        ...paidToAppPayment,
        status: "settlement_pending" as const,
        a2uPaymentId: a2uData.a2uPaymentId,
        a2uStatus: a2uData.status,
        a2uFromAddress: a2uData.fromAddress,
        a2uToAddress: a2uData.toAddress,
      }

      await redis.set(`payment:${paymentId}`, JSON.stringify(settlementPendingPayment))
      console.log("[Pi Webhook] ✓ A2U identifiers stored - payment in SETTLEMENT_PENDING")

      return NextResponse.json({
        status: "settlement_pending",
        message: "Awaiting blockchain signing for settlement",
        a2uPaymentId: a2uData.a2uPaymentId,
      })
    }

    // STEP 4b: A2U FAILED
    if (!a2uResponse.ok || !a2uData.success) {
      console.error("[A2U-FAILURE] ❌ A2U settlement failed")
      console.error("[A2U-FAILURE] Response status:", a2uResponse.status)
      console.error("[A2U-FAILURE] Error:", a2uData.error)
      console.error("[A2U-FAILURE] Details:", a2uData.details)

      // Store failed state with A2U identifiers if available
      const failedPayment = {
        ...paidToAppPayment,
        status: "settlement_failed" as const,
        a2uPaymentId: a2uData.a2uPaymentId || undefined,
        a2uStatus: "failed",
        a2uError: a2uData.error,
        a2uFromAddress: a2uData.fromAddress,
        a2uToAddress: a2uData.toAddress,
        requiresManualReview: true,
        failedAt: new Date().toISOString(),
      }

      await redis.set(`payment:${paymentId}`, JSON.stringify(failedPayment))
      console.log("[Pi Webhook] ✓ Payment marked as SETTLEMENT_FAILED")

      return NextResponse.json({
        status: "settlement_failed",
        error: a2uData.error,
        message: "Settlement to merchant failed",
      }, { status: 400 })
    }

    // STEP 4c: A2U SUCCEEDED - now record to DB atomically
    console.log("[A2U-SUCCESS] ✅ A2U transfer completed")
    console.log("[A2U-SUCCESS] Horizon txid:", a2uData.txid)
    console.log("[A2U-SUCCESS] Recording atomic transaction...")

    // Calculate fees and merchant amount
    const horizonFeeCharged = a2uData.horizonFeeCharged || 0
    const appCommission = a2uData.appCommission || 0
    const merchantAmount = existingPayment.amount - horizonFeeCharged - appCommission

    // Record to DB with fee tracking
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: u2aIdentifier,
      u2aTxid: u2aTxid,
      a2uIdentifier: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      merchantId: merchantId,
      merchantUid: merchantUid,
      amount: existingPayment.amount,
      horizonFeeCharged: horizonFeeCharged,
      appCommission: appCommission,
      note: existingPayment.note || "Payment Settlement",
      createdAt: createdAtDate,
    })

    if (!dbResult.success) {
      console.error("[Pi Webhook] DB atomic write failed:", dbResult.error)
      
      // Atomically save A2U identifiers for retry - do NOT re-submit A2U
      const retryablePayment = {
        ...paidToAppPayment,
        status: "settlement_pending" as const,
        a2uPaymentId: a2uData.a2uPaymentId,
        a2uTxid: a2uData.txid,
        a2uFromAddress: a2uData.fromAddress,
        a2uToAddress: a2uData.toAddress,
        horizonFeeCharged: horizonFeeCharged,
        merchantAmount: merchantAmount,
        appCommission: appCommission,
        requiresDbReconciliation: true,
      }

      await redis.set(`payment:${paymentId}`, JSON.stringify(retryablePayment))
      console.log("[Pi Webhook] ✓ A2U identifiers stored for DB retry (NO A2U resubmission)")

      return NextResponse.json({
        status: "settlement_pending",
        message: "Horizon settlement succeeded but DB write failed - will retry",
        a2uPaymentId: a2uData.a2uPaymentId,
      }, { status: 202 })
    }

    // ONLY NOW: Mark as settled_to_merchant after successful DB commit
    const settledPayment = {
      ...paidToAppPayment,
      status: "settled_to_merchant" as const,
      a2uPaymentId: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      a2uFromAddress: a2uData.fromAddress,
      a2uToAddress: a2uData.toAddress,
      horizonFeeCharged: horizonFeeCharged,
      merchantAmount: merchantAmount,
      appCommission: appCommission,
      settledAt: new Date().toISOString(),
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(settledPayment))
    console.log("[Pi Webhook] ✅ Payment marked as SETTLED_TO_MERCHANT after DB commit")
    console.log("[Pi Webhook] - Merchant received:", merchantAmount, "π")
    console.log("[Pi Webhook] - Horizon fee:", horizonFeeCharged, "π")

    return NextResponse.json({
      status: "settled_to_merchant",
      message: "Payment successfully settled to merchant",
      a2uPaymentId: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      merchantAmount: merchantAmount,
    })
  } catch (error) {
    console.error("[Pi Webhook] COMPLETE error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}
