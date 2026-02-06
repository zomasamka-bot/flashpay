import { type NextRequest, NextResponse } from "next/server"
import { kv } from "@vercel/kv"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'edge'

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
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params
    
    console.log("[API] GET /api/payments/[id] called for:", id)

    const payment = await kv.get<Payment>(`payment:${id}`)

    if (!payment) {
      console.log("[API] Payment not found:", id)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
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

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { id } = params
    const body = await request.json()
    const { status, txid } = body

    console.log("[API] Updating payment:", id, "to status:", status)

    const payment = await kv.get<Payment>(`payment:${id}`)

    if (!payment) {
      console.log("[API] Payment not found in KV")
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
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

    await kv.set(`payment:${id}`, updatedPayment)

    console.log("[API] Payment updated successfully")
    return NextResponse.json({ success: true, payment: updatedPayment })
  } catch (error) {
    console.error("[API] Error updating payment:", error)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}
