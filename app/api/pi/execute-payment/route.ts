import { NextRequest, NextResponse } from "next/server"
import { unifiedStore } from "@/lib/unified-store"

/**
 * Execute A2U (App-to-User) payment for customer payments
 * This is the correct method for PiNet environments
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { paymentId } = body

    console.log("[v0][A2U Payment] Executing payment:", paymentId)

    // Get payment from store
    const payment = unifiedStore.getPaymentById(paymentId)
    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    if (payment.status !== "pending") {
      return NextResponse.json(
        { error: `Payment already ${payment.status}` },
        { status: 400 }
      )
    }

    // Create A2U payment with Pi API
    const PI_API_KEY = process.env.PI_API_KEY
    if (!PI_API_KEY) {
      console.error("[v0][A2U Payment] PI_API_KEY not configured")
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      )
    }

    console.log("[v0][A2U Payment] Creating payment via Pi API...")

    // Step 1: Create payment on Pi server
    const createResponse = await fetch("https://api.minepi.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: payment.amount,
        memo: payment.note || `FlashPay payment ${paymentId}`,
        metadata: { paymentId },
        uid: payment.customerUid, // Customer's Pi UID
      }),
    })

    if (!createResponse.ok) {
      const errorText = await createResponse.text()
      console.error("[v0][A2U Payment] Pi API create failed:", errorText)
      return NextResponse.json(
        { error: "Failed to create payment with Pi Network" },
        { status: 500 }
      )
    }

    const createData = await createResponse.json()
    console.log("[v0][A2U Payment] Payment created:", createData)

    return NextResponse.json({
      success: true,
      identifier: createData.identifier,
      recipientAddress: createData.recipient,
    })
  } catch (error) {
    console.error("[v0][A2U Payment] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
