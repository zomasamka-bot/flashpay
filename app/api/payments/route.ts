import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Import Upstash Redis
import { Redis } from "@upstash/redis"

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
})

// Check Redis availability
const isKvConfigured = !!(
  process.env.UPSTASH_REDIS_REST_URL && 
  process.env.UPSTASH_REDIS_REST_TOKEN
)

console.log("[API] Upstash Redis Configuration Status:")
console.log("[API] - UPSTASH_REDIS_REST_URL:", process.env.UPSTASH_REDIS_REST_URL ? "Set" : "Not Set")
console.log("[API] - UPSTASH_REDIS_REST_TOKEN:", process.env.UPSTASH_REDIS_REST_TOKEN ? "Set" : "Not Set")
console.log("[API] - isKvConfigured:", isKvConfigured)

if (!isKvConfigured) {
  console.error("[API] ❌ CRITICAL: Redis not configured! Payments will FAIL.")
  console.error("[API] ❌ UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.")
}

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
    console.log("[API] Full payment object:", JSON.stringify(payment))

    try {
      if (!isKvConfigured) {
        throw new Error("Redis not configured - cannot store payment")
      }

      const kvKey = `payment:${paymentId}`
      console.log("[API] ========================================")
      console.log("[API] STORING PAYMENT")
      console.log("[API] Payment ID:", paymentId)
      console.log("[API] Redis Key:", kvKey)
      console.log("[API] Instance ID:", process.env.VERCEL_REGION || "local")
      
      console.log("[API] Storing to Upstash Redis...")
      await redis.set(kvKey, JSON.stringify(payment))
      console.log("[API] ✅ Redis.set() completed")
      
      const verification = await redis.get(kvKey)
      console.log("[API] Verification:", verification ? "SUCCESS ✅" : "FAILED ❌")
      
      if (!verification) {
        throw new Error("Payment was not persisted to Redis")
      }
      
      console.log("[API] ========================================")
    } catch (storageError) {
      console.error("[API] ❌ Storage error:", storageError)
      console.error("[API] Error details:", {
        name: storageError instanceof Error ? storageError.name : "Unknown",
        message: storageError instanceof Error ? storageError.message : String(storageError),
        stack: storageError instanceof Error ? storageError.stack : undefined
      })
      
      return NextResponse.json(
        {
          error: "Failed to store payment",
          details: storageError instanceof Error ? storageError.message : String(storageError),
          isKvConfigured: isKvConfigured,
        },
        { status: 500, headers: corsHeaders },
      )
    }

    console.log("[API] ✅ Payment created successfully:", paymentId)
    console.log("[API] Returning payment to client")

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

    if (!isKvConfigured) {
      return NextResponse.json({ 
        error: "Redis not configured",
        paymentId: id,
      }, { status: 500, headers: corsHeaders })
    }

    console.log("[API] Looking up payment with ID:", id)
    console.log("[API] Fetching from Upstash Redis with key:", `payment:${id}`)
    
    const data = await redis.get(`payment:${id}`)
    const payment = data ? (typeof data === 'string' ? JSON.parse(data) : data) : null
    console.log("[API] Redis lookup result:", payment ? "FOUND" : "NOT FOUND")

    if (!payment) {
      console.log("[API] ❌ Payment not found:", id)
      return NextResponse.json({ 
        error: "Payment not found",
        paymentId: id,
      }, { status: 404, headers: corsHeaders })
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
