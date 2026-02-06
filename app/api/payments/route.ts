import { type NextRequest, NextResponse } from "next/server"
import { kv } from "@vercel/kv"

// Force dynamic rendering for this route
export const dynamic = "force-dynamic"
export const runtime = "edge"

interface Payment {
  id: string
  amount: number
  note: string
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  txid?: string
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders })
}

// POST /api/payments - Create a new payment
export async function POST(request: NextRequest) {
  try {
    console.log("[API] POST /api/payments called")

    const body = await request.json()
    const { amount, note } = body

    console.log("[API] Payment request:", { amount, note })

    // Validate required fields
    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid amount. Must be a positive number." },
        { status: 400, headers: corsHeaders },
      )
    }

    // Generate unique payment ID (Edge Runtime compatible)
    const paymentId = crypto.randomUUID()

    // Create payment object
    const payment: Payment = {
      id: paymentId,
      amount,
      note: note || "",
      status: "pending",
      createdAt: new Date().toISOString(),
    }

    console.log("[API] Created payment object:", payment.id)

    try {
      await kv.set(`payment:${paymentId}`, payment)
      console.log("[API] Payment stored successfully in KV:", paymentId)
    } catch (kvError) {
      console.error("[API] KV storage error:", kvError)
      return NextResponse.json(
        {
          error: "Failed to store payment in database",
          details: kvError instanceof Error ? kvError.message : String(kvError),
        },
        { status: 500, headers: corsHeaders },
      )
    }

    console.log("[API] Payment created successfully:", paymentId)

    return NextResponse.json(
      {
        success: true,
        payment: {
          id: payment.id,
          amount: payment.amount,
          note: payment.note,
          status: payment.status,
          createdAt: payment.createdAt,
        },
      },
      { status: 201, headers: corsHeaders },
    )
  } catch (error) {
    console.error("[API] Error creating payment:", error)
    return NextResponse.json(
      { error: "Failed to create payment", details: String(error) },
      { status: 500, headers: corsHeaders },
    )
  }
}

// GET /api/payments?id={paymentId} - Retrieve a payment by ID
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    console.log("[API] GET /api/payments called with id:", id)

    if (!id) {
      return NextResponse.json(
        { error: "Payment ID required. Use ?id=<paymentId>" },
        { status: 400, headers: corsHeaders },
      )
    }

    const payment = await kv.get<Payment>(`payment:${id}`)

    if (!payment) {
      console.log("[API] Payment not found:", id)
      return NextResponse.json({ error: "Payment not found" }, { status: 404, headers: corsHeaders })
    }

    console.log("[API] Payment retrieved:", id)

    return NextResponse.json(
      {
        success: true,
        payment,
      },
      { headers: corsHeaders },
    )
  } catch (error) {
    console.error("[API] Error fetching payment:", error)
    return NextResponse.json({ error: "Failed to fetch payment" }, { status: 500, headers: corsHeaders })
  }
}
