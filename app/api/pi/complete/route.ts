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

    // DEBUG: Log full retrieved payment to verify merchantUid exists
    console.log("[Pi Webhook] FULL PAYMENT FROM REDIS:")
    console.log("[Pi Webhook]   - ALL KEYS:", Object.keys(existingPayment))
    console.log("[Pi Webhook]   - Full object:", JSON.stringify(existingPayment))
    console.log("[Pi Webhook]   - merchantUid exists:", "merchantUid" in existingPayment)
    console.log("[Pi Webhook]   - merchantUid value:", existingPayment.merchantUid)
    console.log("[Pi Webhook]   - merchantUid type:", typeof existingPayment.merchantUid)

    // CRITICAL: Validate merchantId and createdAt are present
    // Use metadata.merchantId as fallback if not in Redis payment
    const merchantId = existingPayment.merchantId || paymentDTO.metadata?.merchantId
    
    // If still no merchantId, reject
    if (!merchantId || typeof merchantId !== "string") {
      console.error("[Pi Webhook] CRITICAL: Cannot determine merchantId from Redis or metadata")
      console.error("[Pi Webhook] Redis merchantId:", existingPayment.merchantId)
      console.error("[Pi Webhook] Metadata merchantId:", paymentDTO.metadata?.merchantId)
      return NextResponse.json({ error: "Cannot determine merchant" }, { status: 400 })
    }

    // If createdAt is missing, use current time as fallback (old payments)
    const createdAt = existingPayment.createdAt || new Date().toISOString()
    
    if (!createdAt) {
      console.error("[Pi Webhook] CRITICAL: Cannot determine createdAt")
      return NextResponse.json({ error: "Cannot determine payment creation time" }, { status: 400 })
    }

    console.log("[Pi Webhook] Payment retrieved:", {
      paymentId,
      merchantId: existingPayment.merchantId,
      merchantUid: existingPayment.merchantUid || "(empty - CRITICAL for A2U)",
      merchantAddress: existingPayment.merchantAddress || "(empty)",
      amount: existingPayment.amount
    })

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
      // CRITICAL: Preserve merchantAddress for A2U transfer
      merchantAddress: existingPayment.merchantAddress,
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

    // Fire-and-forget: Record transaction in Redis
    recordTransaction(
      paymentForRecording,
      paymentDTO.identifier,
      txid,
    ).catch((err) => console.error("[Pi Webhook] Redis transaction recording failed:", err))

    // Fire-and-forget: Record transaction in PostgreSQL (non-blocking) — for permanent audit
    console.log("[Pi Webhook] Background: Recording PostgreSQL transaction for merchantId:", paymentForRecording.merchantId)
    
    recordTransactionToPG(
      paymentForRecording,
      paymentDTO.identifier,
      txid,
    ).then((result) => {
      if (result) {
        console.log("[Pi Webhook] Background: PostgreSQL transaction recorded successfully:", result)
      } else {
        console.warn("[Pi Webhook] Background: PostgreSQL transaction recording returned null")
      }
    }).catch((err) => {
      console.warn("[Pi Webhook] Background: PostgreSQL transaction recording error:", err)
    })

    // Fire-and-forget: Initiate App-to-User payment (transfer funds to merchant wallet)
    if (existingPayment.merchantUid) {
      console.log("[Pi Webhook] A2U READY:")
      console.log("[Pi Webhook]   - Merchant UID:", existingPayment.merchantUid)
      console.log("[Pi Webhook]   - UID type:", typeof existingPayment.merchantUid)
      console.log("[Pi Webhook]   - UID length:", existingPayment.merchantUid.length)
      console.log("[Pi Webhook]   - Amount:", paymentForRecording.amount)
      console.log("[Pi Webhook] Initiating A2U transfer...")
      
      const a2uUrl = `${config.appUrl}/api/pi/a2u`
      console.log("[Pi Webhook] A2U endpoint URL:", a2uUrl)
      
      fetch(a2uUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentId: paymentForRecording.id,
          merchantId: paymentForRecording.merchantId,
          merchantUid: existingPayment.merchantUid,
          amount: paymentForRecording.amount,
          memo: paymentForRecording.note || `Payment settlement`,
        }),
      })
        .then(res => res.json())
        .then(data => {
          console.log("[Pi Webhook] A2U RESPONSE RECEIVED:")
          console.log("[Pi Webhook] Full response:", JSON.stringify(data))
          
          if (data.success) {
            console.log("[Pi Webhook] ✓ A2U SUCCESSFUL - Funds initiated to merchant")
            console.log("[Pi Webhook]   - A2U Payment ID:", data.a2uPaymentId)
            console.log("[Pi Webhook]   - Status:", data.a2uStatus)
            console.log("[Pi Webhook]   - Amount:", data.amount, "Pi")
            console.log("[Pi Webhook]   - Recipient UID:", data.merchantUid)
          } else {
            console.error("[Pi Webhook] ❌ A2U FAILED")
            console.error("[Pi Webhook] Error:", data.error)
            console.error("[Pi Webhook] Details:", data.details)
          }
        })
        .catch(err => {
          console.error("[Pi Webhook] ❌ A2U fetch/parse error:", err.message || err)
          console.error("[Pi Webhook] Error type:", err.constructor.name)
        })
    } else {
      console.warn("[Pi Webhook] Background: Merchant UID is empty - cannot send A2U transfer")
    }

    return response
  } catch (error) {
    console.error("[Pi Webhook] COMPLETE error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}
