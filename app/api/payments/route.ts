import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

import { redis, isRedisConfigured as isKvConfigured } from "@/lib/redis"

interface Payment {
  id: string
  merchantId: string
  merchantAddress?: string
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
    console.log("[API] ========================================")
    console.log("[API] PAYMENT CREATION REQUEST RECEIVED")
    const body = await request.json()
    console.log("[API] Raw request body:", JSON.stringify(body))
    const { amount, note, merchantId, merchantUid } = body

    console.log("[API] Extracted values:")
    console.log("[API]   - amount:", amount, typeof amount)
    console.log("[API]   - note:", note, typeof note)
    console.log("[API]   - merchantId:", merchantId, typeof merchantId)
    console.log("[API]   - merchantUid:", merchantUid, typeof merchantUid)
    console.log("[API] ========================================")

    // Validate merchantId is provided
    if (!merchantId || typeof merchantId !== "string" || merchantId.trim() === "") {
      console.error("[API] ❌ CRITICAL: merchantId is missing or invalid")
      console.error("[API] Request body:", JSON.stringify(body))
      return NextResponse.json(
        {
          error: "merchantId is required",
          received: { amount, note, merchantId, merchantUid },
        },
        { status: 400, headers: corsHeaders },
      )
    }
    console.log("[API] PAYMENT CREATION REQUEST RECEIVED")
    console.log("[API] Request Body:", JSON.stringify(body))
    console.log("[API] Extracted merchantId:", merchantId)
    console.log("[API] Extracted merchantUid:", merchantUid || "(empty)")
    console.log("[API] Extracted amount:", amount)
    console.log("[API] Extracted note:", note)
    console.log("[API] ========================================")

    // Validate required fields
    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid amount. Must be a positive number." },
        { status: 400, headers: corsHeaders },
      )
    }

    // Validate merchantId is provided
    if (!merchantId || typeof merchantId !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing merchantId." },
        { status: 400, headers: corsHeaders },
      )
    }

    // Generate unique payment ID (Edge Runtime compatible)
    const paymentId = crypto.randomUUID()

    // Create payment object with merchantId, merchantUid, and createdAt (REQUIRED FIELDS)
    const payment: Payment = {
      id: paymentId,
      merchantId: merchantId,  // EXPLICITLY SET - Required for transaction tracking
      merchantUid: merchantUid || "", // Store UID for A2U transfers
      amount: amount,
      note: note || "",
      status: "PENDING" as const,  // Use exact type constant
      createdAt: new Date().toISOString() as any,  // Store as ISO string for JSON serialization
    }

    console.log("[API] ========================================")
    console.log("[API] PAYMENT OBJECT CREATED WITH REQUIRED FIELDS:")
    console.log("[API]   - payment.id:", payment.id)
    console.log("[API]   - payment.merchantId:", payment.merchantId, "TYPE:", typeof payment.merchantId)
    console.log("[API]   - payment.merchantUid:", payment.merchantUid, "TYPE:", typeof payment.merchantUid)
    console.log("[API]   - payment.amount:", payment.amount)
    console.log("[API]   - payment.note:", payment.note)
    console.log("[API]   - payment.status:", payment.status)
    console.log("[API]   - payment.createdAt:", payment.createdAt, "TYPE:", typeof payment.createdAt)
    console.log("[API] Full payment object:", JSON.stringify(payment))
    console.log("[API] ========================================")

    try {
      if (!isKvConfigured) {
        throw new Error("Redis not configured - cannot store payment")
      }

      const kvKey = `payment:${paymentId}`
      
      // CRITICAL: Ensure merchantId and createdAt are present before serialization
      if (!payment.merchantId) {
        throw new Error(`CRITICAL: Cannot store payment without merchantId. payment object: ${JSON.stringify(payment)}`)
      }
      if (!payment.createdAt) {
        throw new Error(`CRITICAL: Cannot store payment without createdAt. payment object: ${JSON.stringify(payment)}`)
      }

      const paymentString = JSON.stringify(payment)
      
      console.log("[API] CRITICAL CHECK BEFORE REDIS STORAGE:")
      console.log("[API]   - kvKey:", kvKey)
      console.log("[API]   - Has merchantId:", !!payment.merchantId, "Value:", payment.merchantId)
      console.log("[API]   - Has merchantAddress:", !!payment.merchantAddress, "Value:", payment.merchantAddress)
      console.log("[API]   - Has createdAt:", !!payment.createdAt, "Value:", payment.createdAt)
      console.log("[API]   - JSON includes 'merchantId':", paymentString.includes('"merchantId"'))
      console.log("[API]   - JSON includes 'merchantAddress':", paymentString.includes('"merchantAddress"'))
      console.log("[API]   - JSON includes 'createdAt':", paymentString.includes('"createdAt"'))
      console.log("[API]   - Full JSON string:", paymentString)
      
      await redis.set(kvKey, paymentString)
      console.log("[API] ✅ Redis.set() completed successfully for key:", kvKey)
      
      // CRITICAL: Verify merchantId, merchantAddress and createdAt were actually persisted
      const verification = await redis.get(kvKey)
      if (verification) {
        const storedData = typeof verification === "string" ? JSON.parse(verification) : verification
        console.log("[API] ✅ VERIFICATION AFTER REDIS RETRIEVAL:")
        console.log("[API]   - Retrieved ID:", storedData.id)
        console.log("[API]   - Retrieved merchantId:", storedData.merchantId, "TYPE:", typeof storedData.merchantId)
        console.log("[API]   - Retrieved merchantAddress:", storedData.merchantAddress, "TYPE:", typeof storedData.merchantAddress)
        console.log("[API]   - Retrieved createdAt:", storedData.createdAt, "TYPE:", typeof storedData.createdAt)
        console.log("[API]   - Retrieved amount:", storedData.amount)
        console.log("[API]   - Retrieved status:", storedData.status)
        
        if (!storedData.merchantId) {
          throw new Error(`CRITICAL: merchantId was lost during Redis storage! Stored object: ${JSON.stringify(storedData)}`)
        }
        if (!storedData.createdAt) {
          throw new Error(`CRITICAL: createdAt was lost during Redis storage! Stored object: ${JSON.stringify(storedData)}`)
        }
      } else {
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
          merchantId: payment.merchantId,
          merchantAddress: payment.merchantAddress,
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
