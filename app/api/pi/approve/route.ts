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

    console.log("[Pi Webhook] Pi Payment ID:", paymentDTO.identifier)
    console.log("[Pi Webhook] Our Payment ID:", paymentDTO.metadata?.paymentId)
    console.log("[Pi Webhook] Merchant ID from metadata:", paymentDTO.metadata?.merchantId)

    const paymentId = paymentDTO.metadata?.paymentId
    const merchantId = paymentDTO.metadata?.merchantId
    const customerAddress = paymentDTO.from_address // Customer's wallet address
    
    console.log("[Pi Webhook] Customer wallet (from_address):", customerAddress)
    console.log("[Pi Webhook] App wallet (to_address):", paymentDTO.to_address)

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
        
        // CRITICAL: Also store the payment context (addresses, amounts) for later use in A2U
        // This ensures from_address and to_address are available when A2U retrieves the payment
        const paymentContextKey = `pi:payment:${paymentDTO.identifier}`
        const paymentContext = {
          piPaymentId: paymentDTO.identifier,
          from_address: paymentDTO.from_address, // Customer's wallet
          to_address: paymentDTO.to_address, // App's merchant wallet
          amount: paymentDTO.amount,
          user_uid: paymentDTO.user_uid,
          direction: paymentDTO.direction,
          network: paymentDTO.network,
          created_at: paymentDTO.created_at,
          metadata: paymentDTO.metadata,
          approvedAt: new Date().toISOString(),
        }
        
        await redis.set(paymentContextKey, JSON.stringify(paymentContext), {
          ex: 604800, // 7 days
        })
        
        console.log("[Pi Webhook] Stored payment context with addresses:")
        console.log("[Pi Webhook]   - from_address:", paymentDTO.from_address)
        console.log("[Pi Webhook]   - to_address:", paymentDTO.to_address)
        console.log("[Pi Webhook]   - amount:", paymentDTO.amount)
      } catch (cacheError) {
        console.warn("[Pi Webhook] Could not cache payment context:", cacheError)
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
