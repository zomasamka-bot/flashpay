import { type NextRequest } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
    merchantId?: string
    merchantAddress?: string
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

// POST /api/pi/approve — Called by Pi SDK (onReadyForServerApproval)
// Approves the payment with Pi Network and stores it in Redis
// Idempotent: Multiple calls for the same payment are safe
export async function POST(request: NextRequest) {
  const startMs = Date.now()
  console.log("[Pi Webhook] APPROVE called at", new Date().toISOString())

  try {
    const paymentDTO: PiPaymentDTO = await request.json()

    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] FULL PAYLOAD FROM PI SDK:")
    console.log("[Pi Webhook] Raw JSON:", JSON.stringify(paymentDTO, null, 2))
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] Pi Payment ID:", paymentDTO.identifier)
    console.log("[Pi Webhook] Our Payment ID:", paymentDTO.metadata?.paymentId)
    console.log("[Pi Webhook] Merchant ID from metadata:", paymentDTO.metadata?.merchantId)
    console.log("[Pi Webhook] Merchant Address from metadata:", paymentDTO.metadata?.merchantAddress)
    console.log("[Pi Webhook] Full metadata received:", JSON.stringify(paymentDTO.metadata))

    const paymentId = paymentDTO.metadata?.paymentId
    const merchantId = paymentDTO.metadata?.merchantId
    const merchantAddress = paymentDTO.metadata?.merchantAddress

    if (!paymentId) {
      console.error("[Pi Webhook] Missing paymentId in metadata")
      return new Response(JSON.stringify({ error: "Missing payment ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // CRITICAL: Cache merchant metadata server-side IMMEDIATELY
    // Pi SDK doesn't return custom metadata in webhooks, so we MUST store it now
    // This is the ONLY place where merchantAddress arrives from the customer's wallet
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] CRITICAL: CACHING MERCHANT METADATA")
    console.log("[Pi Webhook] Pi Payment ID (for caching):", paymentDTO.identifier)
    console.log("[Pi Webhook] Merchant ID to cache:", merchantId)
    console.log("[Pi Webhook] Merchant Address to cache:", merchantAddress)
    console.log("[Pi Webhook] ========================================")

    if (isRedisConfigured && merchantId && merchantAddress) {
      const metadataKey = `pi:metadata:${paymentDTO.identifier}`
      const metadataObject = {
        paymentId,
        merchantId,
        merchantAddress,
        timestamp: new Date().toISOString(),
      }

      try {
        await redis.set(metadataKey, JSON.stringify(metadataObject), { ex: 86400 })
        console.log("[Pi Webhook] ✅ Metadata cached successfully")
        console.log("[Pi Webhook]   - Cache Key:", metadataKey)
        console.log("[Pi Webhook]   - merchantId:", merchantId)
        console.log("[Pi Webhook]   - merchantAddress:", merchantAddress)

        // VERIFY the cache was written correctly
        const verification = await redis.get(metadataKey)
        if (verification) {
          const cached = JSON.parse(verification)
          console.log("[Pi Webhook] ✅ VERIFICATION: Metadata in cache has:")
          console.log("[Pi Webhook]   - merchantId:", cached.merchantId)
          console.log("[Pi Webhook]   - merchantAddress:", cached.merchantAddress)
        } else {
          console.error("[Pi Webhook] ❌ CRITICAL: Metadata was NOT cached successfully")
        }
      } catch (cacheError) {
        console.error("[Pi Webhook] ❌ CRITICAL: Failed to cache metadata:", cacheError)
        // Don't fail the approve - we can still get merchantId from our payments table
        // But this is a critical issue we need to know about
      }
    } else {
      console.warn("[Pi Webhook] ⚠️  Cannot cache metadata:")
      console.warn("[Pi Webhook]   - isRedisConfigured:", isRedisConfigured)
      console.warn("[Pi Webhook]   - merchantId present:", !!merchantId)
      console.warn("[Pi Webhook]   - merchantAddress present:", !!merchantAddress)
    }

    // Check if already approved to prevent duplicate API calls
    if (isRedisConfigured) {
      const approvalCacheKey = `pi:approval:${paymentDTO.identifier}`
      try {
        const cached = await redis.get(approvalCacheKey)
        if (cached === "approved") {
          console.log("[Pi Webhook] ✓ Payment already approved (cached), skipping Pi API call")
          return new Response(null, { status: 200 })
        }
      } catch (cacheError) {
        console.warn("[Pi Webhook] Could not check approval cache:", cacheError)
        // Continue anyway
      }
    }

    const approvalResponse = await fetch(
      `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
      },
    )

    const approvalData = await approvalResponse.json().catch(() => ({}))

    // Handle response — both new approval and already_approved are valid
    if (!approvalResponse.ok) {
      // Check if it's "already_approved" — this is valid, not an error
      if (approvalResponse.status === 400 && approvalData.error?.message?.includes("already_approved")) {
        console.log("[Pi Webhook] ✓ Payment already approved on Pi side (developer_approved: true)")
        // Continue - this is not an error, payment IS approved on Pi
      } else {
        console.error("[Pi Webhook] Pi API approval failed:", approvalResponse.status, approvalData)
        return new Response(JSON.stringify({ error: "Approval failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
    } else {
      console.log("[Pi Webhook] ✓ Payment approved via Pi API")
    }

    // Cache the approval to prevent duplicate calls
    if (isRedisConfigured) {
      try {
        const approvalCacheKey = `pi:approval:${paymentDTO.identifier}`
        await redis.setex(approvalCacheKey, 86400, "approved") // Cache for 24 hours
        console.log("[Pi Webhook] Cached approval status")
      } catch (cacheError) {
        console.warn("[Pi Webhook] Could not cache approval status:", cacheError)
        // Non-blocking, continue
      }
    }

    console.log("[Pi Webhook] APPROVE completed in", Date.now() - startMs, "ms")
    return new Response(null, { status: 200 })
  } catch (error) {
    console.error("[Pi Webhook] APPROVE error:", error)
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
