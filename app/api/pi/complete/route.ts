import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Import Upstash Redis
import { Redis } from "@upstash/redis"

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

// Check if Redis is configured
const isKvConfigured = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)

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

// POST /api/pi/complete - Called by Pi Network when payment is confirmed on blockchain
export async function POST(request: NextRequest) {
  try {
    console.log("[Pi Webhook] Complete endpoint called")

    const paymentDTO: PiPaymentDTO = await request.json()

    console.log("[Pi Webhook] Payment completion:", {
      identifier: paymentDTO.identifier,
      txid: paymentDTO.transaction?.txid,
      paymentId: paymentDTO.metadata?.paymentId,
    })

    // Extract our internal payment ID
    const paymentId = paymentDTO.metadata?.paymentId

    if (!paymentId) {
      console.error("[Pi Webhook] Missing paymentId in metadata")
      return NextResponse.json({ error: "Missing paymentId in metadata" }, { status: 400 })
    }

    // Get payment from database
    let existingPayment = null
    
    console.log("[Pi Webhook] Looking up payment:", paymentId)
    console.log("[Pi Webhook] Storage mode:", isKvConfigured ? "KV" : "Memory")
    
    if (isKvConfigured) {
      const data = await redis.get(`payment:${paymentId}`)
      existingPayment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null
    } else {
      console.warn("[Pi Webhook] Redis not configured - cannot retrieve payment")
    }

    if (!existingPayment) {
      console.error("[Pi Webhook] ❌ Payment not found:", paymentId)
      console.error("[Pi Webhook] This means approve/create didn't run in same instance")
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    console.log("[Pi Webhook] ✅ Payment found, completing with Pi API...")

    // CRITICAL: Call Pi Network's API to complete the payment
    const piApiUrl = `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/complete`
    const piApiKey = process.env.PI_API_KEY
    
    if (!piApiKey) {
      console.error("[Pi Webhook] ❌ PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }
    
    const completionResponse = await fetch(piApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${piApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        txid: paymentDTO.transaction?.txid,
      }),
    })
    
    if (!completionResponse.ok) {
      const errorText = await completionResponse.text()
      console.error("[Pi Webhook] ❌ Pi API completion failed:", completionResponse.status, errorText)
      return NextResponse.json({ error: "Completion failed" }, { status: 500 })
    }
    
    console.log("[Pi Webhook] ✅ Payment completed via Pi API")

    // Update payment status to PAID
    const updatedPayment = {
      ...existingPayment,
      status: "paid" as const,
      paidAt: new Date().toISOString(),
      txid: paymentDTO.transaction?.txid,
      piPaymentId: paymentDTO.identifier,
    }

    // Store updated payment
    if (isKvConfigured) {
      await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
      console.log("[Pi Webhook] ✅✅✅ Payment marked as PAID in Redis:", paymentId)
    } else {
      console.warn("[Pi Webhook] ⚠️ Redis not configured - cannot update payment")
    }

    // Respond to Pi Network
    return NextResponse.json({
      success: true,
      message: "Payment completed",
    })
  } catch (error) {
    console.error("[Pi Webhook] Complete error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}
