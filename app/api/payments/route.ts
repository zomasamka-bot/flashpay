import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

import { redis, isRedisConfigured as isKvConfigured, redisRetry } from "@/lib/redis"
import type { Payment } from "@/lib/types"
import { isPaymentFinal } from "@/lib/payment-status"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

// Helper: Filter payment to only include public-safe fields
function getPublicPayment(payment: any) {
  return {
    id: payment.id,
    merchantId: payment.merchantId,
    merchantAddress: payment.merchantAddress,
    amount: payment.amount,
    note: payment.note,
    status: payment.status === "settled_to_merchant" && !isPaymentFinal(payment) ? "settlement_pending" : payment.status,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
    u2aTxid: payment.u2aTxid,
    a2uTxid: payment.a2uTxid,
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders })
}

// POST /api/payments - Create a new payment
export async function POST(request: NextRequest) {
  const paymentTimingStartedAt = Date.now()
  try {
    console.log("[API] ========================================")
    console.log("[API] PAYMENT CREATION REQUEST RECEIVED")
    const body = await request.json()
    const { amount, note, accessToken } = body

    console.log("[API] Extracted values:")
    console.log("[API]   - amount:", amount, typeof amount)
    console.log("[API]   - note:", note, typeof note)
    console.log("[API]   - accessToken:", accessToken ? "PROVIDED" : "MISSING")
    console.log("[API] ========================================")

    // Validate required fields from client
    if (typeof amount !== "number" || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid amount. Must be a positive number." },
        { status: 400, headers: corsHeaders },
      )
    }

    // Validate note (optional but if provided must be a string)
    if (note && typeof note !== "string") {
      return NextResponse.json(
        { error: "Invalid note. Must be a string." },
        { status: 400, headers: corsHeaders },
      )
    }

    // CRITICAL: Verify the UID with Pi /v2/me before creating payment
    console.log("[API] ===== VERIFYING MERCHANT UID WITH PI NETWORK =====")
    
    // Validate accessToken (already extracted at top)
    if (!accessToken || typeof accessToken !== "string") {
      console.error("[API] ❌ accessToken not provided or invalid")
      return NextResponse.json(
        { 
          error: "UID verification failed - no access token provided",
          details: "Frontend must send accessToken in payment creation request"
        },
        { status: 400, headers: corsHeaders }
      )
    }
    
    const piMeTimingStartedAt = Date.now()
    const verifyResponse = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })
    
    if (!verifyResponse.ok) {
      return NextResponse.json(
        {
          error: "UID verification failed with Pi Network",
          piStatus: verifyResponse.status,
        },
        { status: 401, headers: corsHeaders }
      )
    }
    
    console.log("[P7B TIMING] Pi /v2/me", { durationMs: Date.now() - piMeTimingStartedAt })
    const verifiedUser = await verifyResponse.json()
    const verifiedMerchantUid = typeof verifiedUser.uid === "string" ? verifiedUser.uid.trim() : ""
    const trustedMerchantId = typeof verifiedUser.username === "string" ? verifiedUser.username.trim() : ""

    if (verifiedMerchantUid.length === 0 || trustedMerchantId.length === 0) {
      return NextResponse.json({ error: "Verified merchant identity invalid" }, { status: 502, headers: corsHeaders })
    }
    
    console.log("[API] ✅ UID VERIFIED")

    // Generate unique payment ID (Edge Runtime compatible)
    const paymentId = crypto.randomUUID()

    // Create payment object with VERIFIED identity from Pi /v2/me
    const payment: Payment = {
      id: paymentId,
      merchantId: trustedMerchantId, // Use verified username as source of truth
      merchantUid: verifiedMerchantUid, // Use the verified UID from Pi /v2/me
      accessToken: accessToken, // Store accessToken to verify uid again at A2U time
      amount: amount,
      note: note || "",
      status: "pending",
      createdAt: new Date().toISOString(),
    }

    console.log("[API] ========================================")
    console.log("[API] PAYMENT OBJECT CREATED WITH REQUIRED FIELDS:")
    console.log("[API]   - payment.id:", payment.id)
    console.log("[API]   - payment.amount:", payment.amount)
    console.log("[API]   - payment.note:", payment.note)
    console.log("[API]   - payment.status:", payment.status)
    console.log("[API]   - payment.createdAt:", payment.createdAt, "TYPE:", typeof payment.createdAt)
    console.log("[API] ========================================")

    try {
      if (!isKvConfigured) {
        throw new Error("Redis not configured - cannot store payment")
      }

      const kvKey = `payment:${paymentId}`
      
      // CRITICAL: Ensure merchantId and createdAt are present before serialization
      if (!payment.merchantId) {
        throw new Error("CRITICAL: Cannot store payment without merchantId")
      }
      if (!payment.createdAt) {
        throw new Error("CRITICAL: Cannot store payment without createdAt")
      }

      const paymentString = JSON.stringify(payment)
      const historyKey = `flashpay:merchant:${payment.merchantId}:payments:v1`
      const historyScore = Date.parse(payment.createdAt)
      if (!Number.isSafeInteger(historyScore)) {
        throw new Error("Invalid payment createdAt for history index")
      }
      
      console.log("[API] CRITICAL CHECK BEFORE REDIS STORAGE:")
      console.log("[API]   - kvKey:", kvKey)
      console.log("[API]   - Has merchantAddress:", !!payment.merchantAddress, "Value:", payment.merchantAddress)
      console.log("[API]   - Has createdAt:", !!payment.createdAt, "Value:", payment.createdAt)
      console.log("[API]   - JSON includes 'merchantId':", paymentString.includes('"merchantId"'))
      console.log("[API]   - JSON includes 'merchantUid':", paymentString.includes('"merchantUid"'))
      console.log("[API]   - JSON includes 'merchantAddress':", paymentString.includes('"merchantAddress"'))
      console.log("[API]   - JSON includes 'createdAt':", paymentString.includes('"createdAt"'))
      
      const redisPersistTimingStartedAt = Date.now()
      const redisPersistResult = await redis.eval<[string, string, string], number>(
        "if redis.call('EXISTS',KEYS[1])~=0 then return 0 end local a=redis.call('ZADD',KEYS[2],'NX',ARGV[2],ARGV[3]) if a~=1 then return -1 end redis.call('SET',KEYS[1],ARGV[1]) return 1",
        [kvKey, historyKey],
        [paymentString, String(historyScore), payment.id]
      )
      if (redisPersistResult !== 1) {
        throw new Error("Atomic payment persistence failed")
      }
      const redisPersistDurationMs = Date.now() - redisPersistTimingStartedAt
      console.log("[API] ✅ Atomic payment and history index persistence completed successfully for key:", kvKey)
      
      // CRITICAL: Verify merchantId and createdAt were actually persisted
      // Use retry mechanism because Redis might need a moment to confirm the write
      console.log("[API] Starting verification with retry mechanism (3 attempts, 100-400ms backoff)...")
      
      const verification = await redisRetry(
        async () => {
          const result = await redis.get(kvKey)
          console.log("[API] redis.get() returned:", result ? "DATA_FOUND" : "NULL")
          return result
        },
        3, // max retries
        100 // initial delay in ms
      )
      
      if (!verification) {
        throw new Error("Payment verification failed - not found in Redis after 3 retry attempts (300ms total)")
      }
      
      const storedData = typeof verification === "string" ? JSON.parse(verification) : verification
      console.log("[API] VERIFICATION AFTER REDIS RETRIEVAL - PASSED")
      console.log("[API]   - Retrieved ID:", storedData.id)
      console.log("[API]   - Retrieved amount:", storedData.amount)
      console.log("[API]   - Retrieved status:", storedData.status)
      
      // Check critical fields are persisted correctly
      if (storedData.id !== payment.id) {
        throw new Error("CRITICAL: Payment ID mismatch after storage")
      }
      if (storedData.merchantId !== payment.merchantId) {
        throw new Error("CRITICAL: merchantId was corrupted during storage")
      }
      if (storedData.merchantUid !== payment.merchantUid) {
        throw new Error("CRITICAL: merchantUid was corrupted during storage")
      }
      
      console.log("[API] ✅ All verification checks passed - merchantUid successfully persisted")
      console.log("[P7B TIMING] Redis persist/verify", { paymentId, durationMs: Date.now() - redisPersistTimingStartedAt, persistDurationMs: redisPersistDurationMs })
      
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

    console.log("[P7B TIMING] payment total", { paymentId, durationMs: Date.now() - paymentTimingStartedAt })
    return NextResponse.json(
      {
        success: true,
        payment: {
          id: payment.id,
          merchantId: payment.merchantId,
          merchantAddress: payment.merchantAddress,
          merchantUid: payment.merchantUid,
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

    if (typeof payment.id !== "string" || payment.id !== id) {
      return NextResponse.json({ error: "Payment identity conflict", paymentId: id }, { status: 409, headers: corsHeaders })
    }

    return NextResponse.json(
      {
        success: true,
        payment: getPublicPayment(payment),
      },
      { headers: corsHeaders },
    )
  } catch (error) {
    console.error("[API] Error fetching payment:", error)
    return NextResponse.json({ error: "Failed to fetch payment" }, { status: 500, headers: corsHeaders })
  }
}
