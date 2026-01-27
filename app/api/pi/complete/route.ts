import { type NextRequest, NextResponse } from "next/server"
import { kv } from "@vercel/kv"

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
    const existingPayment = await kv.get(`payment:${paymentId}`)

    if (!existingPayment) {
      console.error("[Pi Webhook] Payment not found:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    // Update payment status to PAID
    const updatedPayment = {
      ...existingPayment,
      status: "PAID" as const,
      paidAt: new Date().toISOString(),
      txid: paymentDTO.transaction?.txid,
      piPaymentId: paymentDTO.identifier,
    }

    // Store updated payment
    await kv.set(`payment:${paymentId}`, updatedPayment)

    console.log("[Pi Webhook] Payment marked as PAID:", paymentId)

    // Respond to Pi Network to complete the payment
    return NextResponse.json({
      success: true,
      message: "Payment completed",
    })
  } catch (error) {
    console.error("[Pi Webhook] Complete error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}
