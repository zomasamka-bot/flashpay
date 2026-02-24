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

// Check Redis configuration
const isKvConfigured = !!(
  process.env.UPSTASH_REDIS_REST_URL && 
  process.env.UPSTASH_REDIS_REST_TOKEN
)

console.log("[API][ID] Redis Configuration Status:", isKvConfigured)

if (!isKvConfigured) {
  console.error("[API][ID] ❌ CRITICAL: Redis not configured!")
}

interface Payment {
  id: string
  merchantId?: string
  amount: number
  note: string
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  txid?: string
}

// GET /api/payments/[id] - Retrieve a specific payment
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    
    console.log("[API] GET /api/payments/[id] called for:", id)

    if (!isKvConfigured) {
      return NextResponse.json({ 
        error: "Redis not configured",
        paymentId: id,
      }, { status: 500 })
    }

    console.log("[API][ID] ========================================")
    console.log("[API][ID] RETRIEVING PAYMENT")
    console.log("[API][ID] Payment ID:", id)
    console.log("[API][ID] Redis Key:", `payment:${id}`)
    console.log("[API][ID] Instance ID:", process.env.VERCEL_REGION || "local")
    
    const data = await redis.get(`payment:${id}`)
    const payment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null
    console.log("[API][ID] Redis result:", payment ? "FOUND ✅" : "NOT FOUND ❌")
    console.log("[API][ID] ========================================")

    if (!payment) {
      console.log("[API][ID] ❌ Payment not found:", id)
      return NextResponse.json({ 
        error: "Payment not found",
        paymentId: id,
      }, { status: 404 })
    }

    console.log("[API] Payment retrieved:", id, "status:", payment.status)

    return NextResponse.json({
      success: true,
      payment,
    })
  } catch (error) {
    console.error("[API] Error fetching payment:", error)
    return NextResponse.json({ error: "Failed to fetch payment" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { status, txid } = body

    console.log("[API] ========== PATCH /api/payments/[id] ==========")
    console.log("[API] Payment ID from params:", id)
    console.log("[API] Request body:", { status, txid })

    if (!isKvConfigured) {
      return NextResponse.json({ 
        error: "Redis not configured",
        paymentId: id,
      }, { status: 500 })
    }

    console.log("[API][ID] PATCH - Looking up payment:", id)
    
    const data = await redis.get(`payment:${id}`)
    const payment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null
    console.log("[API][ID] PATCH - Redis result:", payment ? "FOUND" : "NOT FOUND")

    if (!payment) {
      console.log("[API][ID] PATCH - ❌ Payment not found:", id)
      return NextResponse.json({ 
        error: "Payment not found",
        paymentId: id,
      }, { status: 404 })
    }

    // Prevent updating already paid payments
    if (payment.status === "paid") {
      return NextResponse.json({ error: "Payment already completed" }, { status: 400 })
    }

    // Update payment with lowercase status to match webhook format
    const updatedPayment = {
      ...payment,
      status: status.toLowerCase() as "pending" | "paid" | "failed" | "cancelled",
      paidAt: status.toLowerCase() === "paid" ? new Date().toISOString() : payment.paidAt,
      txid: txid || payment.txid,
    }

    await redis.set(`payment:${id}`, JSON.stringify(updatedPayment))
    console.log("[API][ID] PATCH - Updated in Redis")
    console.log("[API] Payment updated successfully")
    return NextResponse.json({ success: true, payment: updatedPayment })
  } catch (error) {
    console.error("[API] Error updating payment:", error)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}
