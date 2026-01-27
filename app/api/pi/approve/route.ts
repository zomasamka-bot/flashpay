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
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
}

// POST /api/pi/approve - Called by Pi Network when payment is initiated
export async function POST(request: NextRequest) {
  try {
    console.log("[Pi Webhook] Approve endpoint called")

    const paymentDTO: PiPaymentDTO = await request.json()

    console.log("[Pi Webhook] Payment data:", {
      identifier: paymentDTO.identifier,
      amount: paymentDTO.amount,
      paymentId: paymentDTO.metadata?.paymentId,
    })

    // Extract our internal payment ID from metadata
    const paymentId = paymentDTO.metadata?.paymentId

    if (!paymentId) {
      console.error("[Pi Webhook] Missing paymentId in metadata")
      return NextResponse.json({ error: "Missing paymentId in metadata" }, { status: 400 })
    }

    // Get existing payment from KV (if merchant stored it) or create new entry
    const existingPayment = await kv.get(`payment:${paymentId}`)

    const payment = {
      id: paymentId,
      amount: paymentDTO.amount,
      note: paymentDTO.memo || "",
      status: "PENDING" as const,
      createdAt: existingPayment?.createdAt || paymentDTO.created_at,
      merchantId: existingPayment?.merchantId || "flashpay",
      piPaymentId: paymentDTO.identifier, // Pi Network's payment ID
      userUid: paymentDTO.user_uid,
      fromAddress: paymentDTO.from_address,
      toAddress: paymentDTO.to_address,
    }

    // Store in Vercel KV
    await kv.set(`payment:${paymentId}`, payment)

    console.log("[Pi Webhook] Payment stored in database:", paymentId)

    // Respond to Pi Network to approve the payment
    return NextResponse.json({
      success: true,
      message: "Payment approved",
    })
  } catch (error) {
    console.error("[Pi Webhook] Approve error:", error)
    return NextResponse.json({ error: "Failed to approve payment" }, { status: 500 })
  }
}
