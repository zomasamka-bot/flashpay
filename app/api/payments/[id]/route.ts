import { type NextRequest, NextResponse } from "next/server"

interface Payment {
  id: string
  merchantId: string
  amount: number
  note: string
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED"
  createdAt: string
  paidAt?: string
  txid?: string
}

const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

async function kvSet(key: string, value: Payment): Promise<boolean> {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    console.error("[v0] KV not configured")
    return false
  }

  try {
    const response = await fetch(`${KV_REST_API_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      },
      body: JSON.stringify(value),
    })
    return response.ok
  } catch (error) {
    console.error("[v0] KV set error:", error)
    return false
  }
}

async function kvGet(key: string): Promise<Payment | null> {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    console.error("[v0] KV not configured")
    return null
  }

  try {
    const response = await fetch(`${KV_REST_API_URL}/get/${key}`, {
      headers: {
        Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    return data.result
  } catch (error) {
    console.error("[v0] KV get error:", error)
    return null
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { status, txid } = body

    console.log("[v0] Updating payment:", id, "to status:", status)

    const payment = await kvGet(`payment:${id}`)

    if (!payment) {
      console.log("[v0] Payment not found in KV")
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    // Prevent updating already paid payments
    if (payment.status === "PAID") {
      return NextResponse.json({ error: "Payment already completed" }, { status: 400 })
    }

    // Update payment
    payment.status = status
    if (status === "PAID") {
      payment.paidAt = new Date().toISOString()
      payment.txid = txid
    }

    const stored = await kvSet(`payment:${id}`, payment)

    if (!stored) {
      console.error("[v0] Failed to update in KV")
      return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
    }

    console.log("[v0] Payment updated successfully")
    return NextResponse.json({ success: true, payment })
  } catch (error) {
    console.error("[v0] Error updating payment:", error)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}
