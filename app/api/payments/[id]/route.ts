import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { redis, isRedisConfigured as isKvConfigured } from "@/lib/redis"

interface Payment {
  id: string
  merchantId?: string
  merchantAddress?: string
  merchantUid?: string
  accessToken: string
  amount: number
  note: string
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  txid?: string
}

// Helper: Filter payment to only include public-safe fields
function getPublicPayment(payment: any) {
  return {
    id: payment.id,
    merchantId: payment.merchantId,
    merchantAddress: payment.merchantAddress,
    amount: payment.amount,
    note: payment.note,
    status: payment.status,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
    txid: payment.txid,
  }
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
      payment: getPublicPayment(payment),
    })
  } catch (error) {
    console.error("[API] Error fetching payment:", error)
    return NextResponse.json({ error: "Failed to fetch payment" }, { status: 500 })
  }
}

export async function PATCH() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}
