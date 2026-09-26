import { type NextRequest, NextResponse } from "next/server"

// Force dynamic rendering for this route
export const dynamic = "force-dynamic"
export const runtime = "nodejs"

import { redis, isRedisConfigured as isKvConfigured, redisRetry } from "@/lib/redis"
import type { Payment } from "@/lib/types"
import { isPaymentFinal } from "@/lib/payment-status"
import { readSystemState } from "@/lib/system-control"
import { ensureSettlementCheckpointTable, recordSettlementPaymentIdentityCheckpoint, recordDr11RefundCertificationHold, readDr11RefundCertificationHold } from "@/lib/db"
import { consumeFinancialRateLimit } from "@/lib/server-rate-limit"

const DR10_MAINTENANCE_KEY = "flashpay:certification:dr10:maintenance:v1"
const PAYMENT_CREATE_LEASE_PREFIX = "flashpay:payment:create-active:"

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
  let createLeaseKey: string | null = null
  try {
    // DR56: the DR10 environment flag grants certification capability; it is not
    // operational maintenance state. Only the short-lived owner-triggered Redis
    // maintenance key blocks new payment creation. Each admitted creator holds a
    // lease that the atomic DR10 FLUSHDB script must observe and reject, closing
    // the in-flight creation race without disabling normal production forever.
    if (!isKvConfigured) {
      return NextResponse.json({ error: "Payment persistence unavailable", code: "PAYMENT_REDIS_UNAVAILABLE" }, { status: 503, headers: corsHeaders })
    }
    const dr10Maintenance = await redis.get(DR10_MAINTENANCE_KEY)
    if (dr10Maintenance !== null) {
      if (typeof dr10Maintenance !== "string" || dr10Maintenance.length < 16 || dr10Maintenance.length > 128) {
        return NextResponse.json({ error: "Service temporarily unavailable", code: "DR10_MAINTENANCE_STATE_INVALID" }, { status: 503, headers: corsHeaders })
      }
      return NextResponse.json({ error: "Service temporarily unavailable", code: "DR10_CERTIFICATION_MAINTENANCE" }, { status: 503, headers: corsHeaders })
    }
    createLeaseKey = `${PAYMENT_CREATE_LEASE_PREFIX}${crypto.randomUUID()}`
    const createLease = await redis.set(createLeaseKey, "active", { nx: true, ex: 120 })
    if (createLease !== "OK") {
      return NextResponse.json({ error: "Payment creation temporarily unavailable", code: "PAYMENT_CREATE_LEASE_UNAVAILABLE" }, { status: 503, headers: corsHeaders })
    }
    // M9: kill switch blocks creation of NEW financial flows only.
    // Existing payment completion/recovery routes remain available so funds are never stranded.
    const control = await readSystemState()
    if (!control.ok || control.state.killSwitchEnabled) {
      return NextResponse.json(
        { error: "Service temporarily unavailable", code: "SYSTEM_MAINTENANCE" },
        { status: 503, headers: corsHeaders },
      )
    }
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
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1000000 || Number(amount.toFixed(7)) !== amount) {
      return NextResponse.json(
        { error: "Invalid amount. Must be a positive number." },
        { status: 400, headers: corsHeaders },
      )
    }

    // Validate note (optional but if provided must be a string)
    if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
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
    
    // R101-8: creation abuse control is keyed to the Pi-verified merchant UID,
    // never IP-only. No payment identity exists yet, so limiter uncertainty can
    // safely fail closed without stranding an existing financial lifecycle.
    const creationLimit = await consumeFinancialRateLimit({
      namespace: "payments-create", subject: verifiedMerchantUid, limit: 30, windowSeconds: 60,
    })
    if (creationLimit.outcome === "LIMITED") {
      return NextResponse.json({ error: "Too many payment creation requests", code: "RATE_LIMITED" }, { status: 429, headers: { ...corsHeaders, "Retry-After": String(creationLimit.retryAfterSeconds) } })
    }
    if (creationLimit.outcome === "UNAVAILABLE") {
      return NextResponse.json({ error: "Payment creation temporarily unavailable", code: "RATE_LIMIT_UNAVAILABLE" }, { status: 503, headers: corsHeaders })
    }

    console.log("[API] ✅ UID VERIFIED")

    // Generate unique payment ID (Edge Runtime compatible)
    const paymentId = crypto.randomUUID()

    // Create payment object with VERIFIED identity from Pi /v2/me
    const payment: Payment = {
      id: paymentId,
      merchantId: trustedMerchantId, // Use verified username as source of truth
      merchantUid: verifiedMerchantUid, // Use the verified UID from Pi /v2/me
      redisProjectionVersion: 1, // F2-6 initial projection fence
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

    if (!isKvConfigured) {
      return NextResponse.json(
        { error: "Payment persistence unavailable", code: "PAYMENT_REDIS_UNAVAILABLE" },
        { status: 503, headers: corsHeaders },
      )
    }

    // DR-13: a clean-install first payment request must establish the durable
    // Settlement authority schema before attempting the F2-1 identity write.
    // Idempotent PostgreSQL DDL is safe under concurrent cold-start requests.
    if (!(await ensureSettlementCheckpointTable())) {
      return NextResponse.json(
        { error: "Payment durability unavailable", code: "PAYMENT_SCHEMA_UNAVAILABLE" },
        { status: 503, headers: corsHeaders },
      )
    }

    // F2-1: PostgreSQL durable identity is established before Redis can expose a
    // payment to the client. No access token, Pi payment, Settlement movement, or
    // Refund movement is persisted or authorized by this checkpoint.
    const durableIdentityTimingStartedAt = Date.now()
    const durableIdentity = await recordSettlementPaymentIdentityCheckpoint({
      paymentId: payment.id,
      merchantId: trustedMerchantId,
      merchantUid: verifiedMerchantUid,
      customerAmount: payment.amount,
    })
    if (durableIdentity.outcome !== "RECORDED") {
      console.error("[F2-1 PAYMENT IDENTITY] durable checkpoint unavailable", { paymentId, outcome: durableIdentity.outcome })
      return NextResponse.json(
        { error: "Payment durability unavailable", code: "PAYMENT_IDENTITY_DURABILITY_UNAVAILABLE" },
        { status: 503, headers: corsHeaders },
      )
    }
    console.log("[F2-1 PAYMENT IDENTITY] durable", { paymentId, version: durableIdentity.version, durationMs: Date.now() - durableIdentityTimingStartedAt })

    try {
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
      const dr11CreationCandidate = process.env.VERCEL_ENV === "production" && payment.amount === 0.1 && payment.merchantId === "hazemaboria" && payment.merchantUid === "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"
      const redisPersistResult = await redis.eval(
        "if redis.call('EXISTS',KEYS[1])~=0 then return 0 end local a=redis.call('ZADD',KEYS[2],'NX',ARGV[2],ARGV[3]) if a~=1 then return -1 end redis.call('SET',KEYS[1],ARGV[1]) if ARGV[4]=='1' and redis.call('GET',KEYS[3])==ARGV[5] then redis.call('SET',KEYS[4],ARGV[5],'EX',ARGV[6]); redis.call('DEL',KEYS[3]); return 2 end return 1",
        [kvKey, historyKey, "flashpay:certification:dr11:next-010:v1", `flashpay:certification:dr11:payment:${payment.id}`],
        [paymentString, String(historyScore), payment.id, dr11CreationCandidate ? "1" : "0", "armed:v1", "900"]
      )
      if (redisPersistResult !== 1 && redisPersistResult !== 2) {
        throw new Error("Atomic payment persistence failed")
      }
      if (redisPersistResult === 2) {
        const durableHold = await recordDr11RefundCertificationHold({ paymentId: payment.id, merchantId: trustedMerchantId, merchantUid: verifiedMerchantUid, customerAmount: payment.amount })
        if (durableHold.outcome !== "RECORDED" && durableHold.outcome !== "REPLAYED") {
          // DR62: a write error can be post-commit. Re-read PostgreSQL before any compensation.
          const authoritativeHold = await readDr11RefundCertificationHold(payment.id)
          if (authoritativeHold.outcome !== "HELD") {
            console.error("[DR62 DR11 DURABLE HOLD] binding unresolved", { paymentId: payment.id, writeOutcome: durableHold.outcome, readOutcome: authoritativeHold.outcome })
            if (authoritativeHold.outcome === "ABSENT") {
              // Only a proven ABSENT durable hold may compensate Redis. The Lua script is exact-value
              // guarded and atomic: payment, history member and exact selector disappear together.
              const compensated = await redis.eval(
                "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end if redis.call('GET',KEYS[3])~=ARGV[2] then return 0 end redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],ARGV[3]); redis.call('DEL',KEYS[3]); return 1",
                [kvKey, historyKey, `flashpay:certification:dr11:payment:${payment.id}`],
                [paymentString, "armed:v1", payment.id],
              )
              if (compensated !== 1) console.error("[DR62 DR11 COMPENSATION] exact Redis cleanup not proven", { paymentId: payment.id })
              else console.warn("[DR62 DR11 COMPENSATION] exact non-financial Redis binding removed", { paymentId: payment.id })
            }
            // INDETERMINATE deliberately preserves the selector. DR61 approve gate then blocks Pi /approve
            // until PostgreSQL authority is knowable; never delete or recreate authority on uncertainty.
            return NextResponse.json({ error: "DR11 durable certification hold unavailable", code: "DR11_DURABLE_HOLD_UNAVAILABLE" }, { status: 503, headers: corsHeaders })
          }
          console.warn("[DR62 DR11 DURABLE HOLD] post-write authoritative replay confirmed", { paymentId: payment.id, writeOutcome: durableHold.outcome })
        }
        console.warn("[DR62 DR11 DURABLE HOLD] exact payment bound", { paymentId: payment.id, amount: payment.amount, durable: true })
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
  } finally {
    if (createLeaseKey) {
      try { await redis.del(createLeaseKey) } catch { console.warn("[DR56 PAYMENT CREATE LEASE] cleanup deferred to TTL") }
    }
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
