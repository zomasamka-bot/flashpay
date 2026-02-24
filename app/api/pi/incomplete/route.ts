import { type NextRequest, NextResponse } from "next/server"
import { Redis } from "@upstash/redis"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
  }
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
}

// POST /api/pi/incomplete - Called by Pi Network when payment is cancelled/incomplete
export async function POST(request: NextRequest) {
  try {
    console.log("[Pi Webhook] Incomplete endpoint called")

    const paymentDTO: PiPaymentDTO = await request.json()

    console.log("[Pi Webhook] Payment cancelled:", {
      identifier: paymentDTO.identifier,
      paymentId: paymentDTO.metadata?.paymentId,
      userCancelled: paymentDTO.status?.user_cancelled,
    })

    const paymentId = paymentDTO.metadata?.paymentId

    if (!paymentId) {
      console.error("[Pi Webhook] Missing paymentId in metadata")
      return NextResponse.json({ error: "Missing paymentId in metadata" }, { status: 400 })
    }

    // Get payment from database
    const data = await redis.get(`payment:${paymentId}`)
    const existingPayment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null

    if (!existingPayment) {
      console.error("[Pi Webhook] Payment not found:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    // Update payment status to CANCELLED
    const updatedPayment = {
      ...existingPayment,
      status: "cancelled" as const,
      cancelledAt: new Date().toISOString(),
      piPaymentId: paymentDTO.identifier,
    }

    // Store updated payment
    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))

    console.log("[Pi Webhook] Payment marked as CANCELLED:", paymentId)

    return NextResponse.json({
      success: true,
      message: "Payment cancellation recorded",
    })
  } catch (error) {
    console.error("[Pi Webhook] Incomplete error:", error)
    return NextResponse.json({ error: "Failed to process incomplete payment" }, { status: 500 })
  }
}
