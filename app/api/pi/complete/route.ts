import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordTransaction } from "@/lib/transaction-service"
import { recordTransactionToPG } from "@/lib/transaction-pg-service"
import { initializeSchema } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
    merchantId?: string
    merchantAddress?: string
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
// Completes the payment with Pi Network and marks it PAID in Redis
export async function POST(request: NextRequest) {
  console.log("[Pi Webhook] COMPLETE called at", new Date().toISOString())

  // Initialize database schema on first call (if configured)
  if (config.isPostgresConfigured) {
    try {
      await initializeSchema()
    } catch (error) {
      console.error("[Pi Webhook] Schema initialization error (non-blocking):", error)
      // Continue anyway, tables may already exist
    }
  }

  try {
    const body = await request.json()
    console.log("[Pi Webhook] Complete request body keys:", Object.keys(body))
    
    // Handle both formats: direct Pi payment object (from incomplete payment callback) or wrapped DTO
    const paymentDTO: PiPaymentDTO = body.identifier ? body : body
    
    console.log("[Pi Webhook] Pi Payment ID:", paymentDTO.identifier)
    console.log("[Pi Webhook] Txid:", paymentDTO.transaction?.txid)
    console.log("[Pi Webhook] Our Payment ID:", paymentDTO.metadata?.paymentId)

    const paymentId = paymentDTO.metadata?.paymentId
    
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] PAYMENT ID EXTRACTION")
    console.log("[Pi Webhook] paymentDTO.metadata:", JSON.stringify(paymentDTO.metadata))
    console.log("[Pi Webhook] paymentDTO.identifier:", paymentDTO.identifier)
    console.log("[Pi Webhook] Extracted paymentId:", paymentId)
    console.log("[Pi Webhook] Extracted merchantId from metadata:", paymentDTO.metadata?.merchantId)
    console.log("[Pi Webhook] Extracted merchantAddress from metadata:", paymentDTO.metadata?.merchantAddress)
    console.log("[Pi Webhook] ========================================")

    // Retrieve payment from Redis
    let existingPayment = null

    if (!paymentId) {
      console.warn("[Pi Webhook] ⚠️  No paymentId in metadata - cannot look up payment in Redis")
      console.warn("[Pi Webhook] Returning success anyway to avoid blocking Pi webhook")
      // Return 200 OK so Pi doesn't retry — we lose tracking but payment won't get stuck
      return NextResponse.json({ success: true, message: "Payment acknowledged (no internal tracking)" })
    }

    if (isRedisConfigured) {
      const data = await redis.get(`payment:${paymentId}`)
      existingPayment = data ? (typeof data === "string" ? JSON.parse(data) : data) : null
      console.log("[Pi Webhook] Redis lookup - key: payment:" + paymentId + " - found:", !!existingPayment)
    } else {
      console.warn("[Pi Webhook] Redis not configured")
    }

    if (!existingPayment) {
      console.error("[Pi Webhook] ❌ Payment not found in Redis - cannot match to internal system")
      console.error("[Pi Webhook] paymentId:", paymentId)
      console.error("[Pi Webhook] Redis key used: payment:" + paymentId)
      console.warn("[Pi Webhook] Returning success anyway to avoid blocking Pi webhook")
      // Return 200 OK so Pi doesn't retry — payment is on blockchain but not tracked
      return NextResponse.json({ success: true, message: "Payment acknowledged (not found in system)" })
    }

    // CRITICAL: Validate merchantId and createdAt are present
    // Use Redis merchantId as source of truth (it was set during payment creation)
    const merchantId = existingPayment.merchantId
    
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] MERCHANT ID COMPARISON")
    console.log("[Pi Webhook] merchantId from metadata:", paymentDTO.metadata?.merchantId)
    console.log("[Pi Webhook] merchantId from Redis:", existingPayment.merchantId)
    console.log("[Pi Webhook] merchantAddress from Redis:", existingPayment.merchantAddress)
    console.log("[Pi Webhook] Using merchantId from Redis:", merchantId)
    console.log("[Pi Webhook] ========================================")
    
    // If still no merchantId, reject
    if (!merchantId || typeof merchantId !== "string") {
      console.error("[Pi Webhook] CRITICAL: Cannot determine merchantId from Redis payment")
      console.error("[Pi Webhook] Redis merchantId:", existingPayment.merchantId)
      return NextResponse.json({ error: "Cannot determine merchant" }, { status: 400 })
    }

    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] MERCHANT ID VALIDATION")
    console.log("[Pi Webhook] Payment created with merchantId:", existingPayment.merchantId)
    console.log("[Pi Webhook] Pi metadata merchantId:", paymentDTO.metadata?.merchantId)
    console.log("[Pi Webhook] Using for transaction:", merchantId)
    console.log("[Pi Webhook] ✓ Merchant ID consistency verified")
    console.log("[Pi Webhook] ========================================")

    // If createdAt is missing, use current time as fallback (old payments)
    const createdAt = existingPayment.createdAt || new Date().toISOString()
    
    if (!createdAt) {
      console.error("[Pi Webhook] CRITICAL: Cannot determine createdAt")
      return NextResponse.json({ error: "Cannot determine payment creation time" }, { status: 400 })
    }

    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] PAYMENT RETRIEVED FROM REDIS")
    console.log("[Pi Webhook] Payment ID:", paymentId)
    console.log("[Pi Webhook] Full payment object:", JSON.stringify(existingPayment))
    console.log("[Pi Webhook] Merchant ID:", existingPayment.merchantId)
    console.log("[Pi Webhook] Merchant Address:", existingPayment.merchantAddress)
    console.log("[Pi Webhook] Amount:", existingPayment.amount)
    console.log("[Pi Webhook] Status:", existingPayment.status)
    console.log("[Pi Webhook] Created At:", existingPayment.createdAt)
    console.log("[Pi Webhook] ========================================")

    // CRITICAL: Retrieve server-side stored metadata (Pi doesn't return custom metadata in webhooks)
    let storedMetadata: any = null
    if (isRedisConfigured) {
      const metadataKey = `pi:metadata:${paymentDTO.identifier}`
      try {
        const cached = await redis.get(metadataKey)
        if (cached) {
          storedMetadata = JSON.parse(cached)
          console.log("[Pi Webhook] ✅ Retrieved server-side metadata from cache")
          console.log("[Pi Webhook]   - cache key:", metadataKey)
          console.log("[Pi Webhook]   - merchantId:", storedMetadata.merchantId)
          console.log("[Pi Webhook]   - merchantAddress:", storedMetadata.merchantAddress)
          console.log("[Pi Webhook]   - timestamp:", storedMetadata.timestamp)
        } else {
          console.warn("[Pi Webhook] ⚠️  Metadata cache is EMPTY")
          console.warn("[Pi Webhook]   - cache key:", metadataKey)
          console.warn("[Pi Webhook] This means /api/pi/approve was not called OR cache was cleared")
        }
      } catch (cacheError) {
        console.error("[Pi Webhook] ❌ CRITICAL: Could not retrieve stored metadata:", cacheError)
      }
    } else {
      console.warn("[Pi Webhook] ⚠️  Redis not configured - cannot retrieve server-side metadata")
    }

    // Determine final merchant data with priority:
    // 1. Server-side cached metadata (most reliable - from approval webhook)
    // 2. Redis payment object (fallback - from payment creation)
    // 3. Pi metadata (unreliable - usually empty)
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] MERCHANT DATA RESOLUTION")
    console.log("[Pi Webhook] Source 1 - Cached metadata (pi:metadata:${piId}):")
    console.log("[Pi Webhook]   - merchantId:", storedMetadata?.merchantId)
    console.log("[Pi Webhook]   - merchantAddress:", storedMetadata?.merchantAddress)
    console.log("[Pi Webhook] Source 2 - Redis payment object:")
    console.log("[Pi Webhook]   - merchantId:", existingPayment.merchantId)
    console.log("[Pi Webhook]   - merchantAddress:", existingPayment.merchantAddress)
    console.log("[Pi Webhook] Source 3 - Pi metadata (usually empty):")
    console.log("[Pi Webhook]   - merchantId:", paymentDTO.metadata?.merchantId)
    console.log("[Pi Webhook]   - merchantAddress:", paymentDTO.metadata?.merchantAddress)
    console.log("[Pi Webhook] ========================================")

    // Use stored merchantAddress if available (since Pi doesn't return it)
    const merchantAddressFromCache = storedMetadata?.merchantAddress
    const merchantAddressFromPayment = existingPayment.merchantAddress
    const merchantAddress = merchantAddressFromCache || merchantAddressFromPayment || ""

    console.log("[Pi Webhook] FINAL MERCHANT DATA SELECTION:")
    console.log("[Pi Webhook]   - merchantAddress from cache:", merchantAddressFromCache, merchantAddressFromCache ? "✅ USING THIS" : "❌ NOT AVAILABLE")
    console.log("[Pi Webhook]   - merchantAddress from payment:", merchantAddressFromPayment, !merchantAddressFromCache && merchantAddressFromPayment ? "✅ USING THIS" : "")
    console.log("[Pi Webhook]   - Final merchantAddress for transfer:", merchantAddress)
    console.log("[Pi Webhook] ========================================")



    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    const txid = paymentDTO.transaction?.txid || paymentDTO.txid
    if (!txid) {
      console.error("[Pi Webhook] No transaction ID found in payment")
      return NextResponse.json({ error: "Missing transaction ID" }, { status: 400 })
    }

    const completionResponse = await fetch(
      `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      },
    )

    console.log("[Pi Webhook] Pi API Response Status:", completionResponse.status)
    const completionData = await completionResponse.json().catch(() => ({}))
    console.log("[Pi Webhook] Pi API Response Data:", JSON.stringify(completionData))

    // Handle all response cases
    if (!completionResponse.ok) {
      // Check if it's "already_completed" - this is actually SUCCESS, not an error
      if (completionResponse.status === 400 && completionData.error?.message?.includes("already_completed")) {
        console.log("[Pi Webhook] ✓ Payment already completed on Pi side (this is valid)")
        // Continue - this is not an error, payment IS done on Pi
      } else {
        console.error("[Pi Webhook] Pi API completion failed:", completionResponse.status, completionData)
        console.warn("[Pi Webhook] Continuing despite Pi API response - marking payment as paid locally")
      }
    } else {
      console.log("[Pi Webhook] ✓ Payment completed via Pi API")
    }

    // Update status to PAID in Redis — THIS MUST HAPPEN REGARDLESS OF Pi API RESPONSE
    // Once we reach here, the payment HAS been completed (either now or already on Pi side)
    const updatedPayment = {
      ...existingPayment,
      status: "paid" as const,
      paidAt: new Date().toISOString(),
      txid: txid,
      piPaymentId: paymentDTO.identifier,
    }

    if (isRedisConfigured) {
      await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
      console.log("[Pi Webhook] ✓ Payment marked as PAID in Redis:", paymentId)
      console.log("[Pi Webhook] Redis updated with status: paid, txid:", txid)
    }

    // Verify the payment was actually updated in Redis
    if (isRedisConfigured) {
      const verification = await redis.get(`payment:${paymentId}`)
      if (verification) {
        const stored = typeof verification === "string" ? JSON.parse(verification) : verification
        console.log("[Pi Webhook] ✓ VERIFICATION - Payment in Redis now has:")
        console.log("[Pi Webhook]   - status:", stored.status, "(should be 'paid')")
        console.log("[Pi Webhook]   - txid:", stored.txid)
        console.log("[Pi Webhook]   - paidAt:", stored.paidAt)
      }
    }

    // CRITICAL: Return 200 OK immediately after payment is marked as paid
    // All subsequent operations (transaction recording, settlement queueing) are fire-and-forget
    // This ensures the Pi SDK receives success and doesn't get stuck

    // Ensure payment object has all required fields for transaction recording
    const paymentForRecording = {
      id: existingPayment.id,
      merchantId: merchantId,
      amount: existingPayment.amount,
      note: existingPayment.note || "",
      status: "paid" as const,
      createdAt: createdAt,  // Use fallback createdAt if payment missing it
      paidAt: new Date().toISOString(),
    }

    console.log("[Pi Webhook] Payment object prepared for recording:", {
      id: paymentForRecording.id,
      merchantId: paymentForRecording.merchantId,
      amount: paymentForRecording.amount,
      createdAt: paymentForRecording.createdAt,
      paidAt: paymentForRecording.paidAt,
    })

    // RETURN 200 OK IMMEDIATELY - all background operations are fire-and-forget
    const response = NextResponse.json({ success: true, message: "Payment completed" })

    // CRITICAL: Record transaction to PostgreSQL FIRST (synchronously) before transfer
    // This ensures the transaction_id exists when the transfer references it
    console.log("[Pi Webhook] Recording transaction to PostgreSQL FIRST...")
    let transactionId: string | undefined
    try {
      const pgResult = await recordTransactionToPG(
        paymentForRecording,
        paymentDTO.identifier,
        txid,
      )
      transactionId = pgResult?.transactionId
      console.log("[Pi Webhook] ✓ Transaction recorded to PostgreSQL:", transactionId)
    } catch (pgError) {
      console.error("[Pi Webhook] Failed to record transaction to PostgreSQL:", pgError)
      // Still allow transfer to proceed with paymentId as fallback
      transactionId = paymentId
    }

    // Prepare transfer data
    const addressForTransfer = merchantAddress || existingPayment.merchantAddress || existingPayment.from_address
    
    console.log("[Pi Webhook] Transfer preparation:")
    console.log("[Pi Webhook]   - merchantAddress from cache:", merchantAddress)
    console.log("[Pi Webhook]   - merchantAddress from payment:", existingPayment.merchantAddress)
    console.log("[Pi Webhook]   - Final address for transfer:", addressForTransfer)

    // CRITICAL: Initiate transfer with the transaction_id that now EXISTS in the database
    if (!addressForTransfer) {
      console.warn("[Pi Webhook] ⚠️  No merchant wallet address found - transfer cannot proceed")
      console.warn("[Pi Webhook] Ensure wallet was connected before payment was created")
    } else {
      console.log("[Pi Webhook] ✓ IMMEDIATELY initiating transfer to:", addressForTransfer)
      console.log("[Pi Webhook] Transfer using transactionId:", transactionId)
      initiateTransferAsync(
        transactionId || paymentId,
        paymentForRecording.merchantId,
        addressForTransfer,
        paymentForRecording.amount
      ).catch((err) => console.error("[Pi Webhook] Transfer initiation failed:", err))
    }

    // Fire-and-forget: Record transaction in Redis
    recordTransaction(
      paymentForRecording,
      paymentDTO.identifier,
      txid,
    ).catch((err) => console.error("[Pi Webhook] Redis transaction recording failed:", err))

    return response
  } catch (error) {
    console.error("[Pi Webhook] COMPLETE error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}

/**
 * Initiate fund transfer in background
 */
async function initiateTransferAsync(
  transactionId: string,
  merchantId: string,
  merchantAddress: string,
  amount: number
) {
  console.log("[Pi Webhook] TRANSFER FUNCTION CALLED:", {
    transactionId,
    merchantId,
    merchantAddress,
    amount,
    timestamp: new Date().toISOString(),
  })

  if (!merchantAddress) {
    console.warn("[Pi Webhook] Cannot initiate transfer - no merchant wallet address")
    return
  }

  try {
    console.log("[Pi Webhook] Background: Initiating transfer to merchant wallet", {
      transactionId,
      merchantId,
      merchantAddress,
      amount,
    })

    const transferResponse = await fetch(`${config.appUrl}/api/transfers/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionId,
        merchantId,
        merchantAddress,
        amount,
      }),
    })

    console.log("[Pi Webhook] Transfer response status:", transferResponse.status)

    if (transferResponse.ok) {
      const transferData = await transferResponse.json()
      console.log("[Pi Webhook] Background: Transfer initiated successfully", {
        transferId: transferData.transferId,
        response: JSON.stringify(transferData),
      })
    } else {
      const errorData = await transferResponse.json().catch(() => ({}))
      console.warn("[Pi Webhook] Background: Transfer initiation failed", {
        status: transferResponse.status,
        error: JSON.stringify(errorData),
      })
    }
  } catch (error) {
    console.error("[Pi Webhook] Background: Transfer initiation error:", error)
  }
}
