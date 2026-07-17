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
// Approves the payment with Pi Network after canonical validation
// Security: Fetches canonical Pi payment, derives paymentId from canonical metadata, validates Redis record
// Idempotent: Returns 200 for already-paid when piPaymentId matches identifier
export async function POST(request: NextRequest) {
  const startMs = Date.now()
  console.log("[Pi Webhook] APPROVE called at", new Date().toISOString())

  try {
    // Extract only identifier from untrusted request body
    const body: { identifier?: unknown } = await request.json()
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : ""

    if (!identifier) {
      console.error("[Pi Webhook] Missing or invalid identifier in request")
      return new Response(JSON.stringify({ error: "Missing identifier" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    console.log("[Pi Webhook] Pi Payment ID:", identifier)

    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return new Response(JSON.stringify({ error: "Server not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // SECURITY: Fetch canonical Pi payment before any cache check or approval call
    console.log("[Pi Webhook] Fetching canonical Pi payment...")
    const piGetResponse = await fetch(
      `https://api.minepi.com/v2/payments/${identifier}`,
      {
        method: "GET",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
      },
    )

    if (!piGetResponse.ok) {
      console.error("[Pi Webhook] Failed to fetch canonical Pi payment:", piGetResponse.status)
      return new Response(JSON.stringify({ error: "Payment not found on Pi" }), {
        status: piGetResponse.status,
        headers: { "Content-Type": "application/json" },
      })
    }

    const canonicalPayment = await piGetResponse.json()
    console.log("[Pi Webhook] Canonical Pi Payment ID:", canonicalPayment.identifier)

    // Derive paymentId ONLY from canonical metadata
    const paymentId = canonicalPayment.metadata?.paymentId
    if (!paymentId) {
      console.error("[Pi Webhook] Missing paymentId in canonical Pi metadata")
      return new Response(JSON.stringify({ error: "Invalid payment metadata" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    console.log("[Pi Webhook] Our Payment ID:", paymentId)

    // FAIL CLOSED: Require Redis to be configured and payment record to exist
    if (!isRedisConfigured) {
      console.error("[Pi Webhook] SECURITY: Redis not configured - cannot approve without local record")
      return new Response(JSON.stringify({ error: "Server configuration error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Load canonical payment from Redis
    let redisPayment = null
    try {
      const stored = await redis.get(`payment:${paymentId}`)
      redisPayment = stored ? (typeof stored === "string" ? JSON.parse(stored) : stored) : null
    } catch (error) {
      console.error("[Pi Webhook] SECURITY: Could not load Redis payment:", error)
      return new Response(JSON.stringify({ error: "Payment record unavailable" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // FAIL CLOSED: Require Redis payment record to exist before /approve
    if (!redisPayment) {
      console.error("[Pi Webhook] SECURITY: No Redis payment record found for", paymentId)
      return new Response(JSON.stringify({ error: "Payment not found in system" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Idempotency check: Return 200 for already-paid only when piPaymentId matches identifier
    if (redisPayment.status?.toLowerCase() === "paid") {
      if (redisPayment.piPaymentId === identifier) {
        console.log("[Pi Webhook] ✓ Payment already paid - piPaymentId matches identifier, returning 200")
        return new Response(null, { status: 200 })
      } else {
        console.error("[Pi Webhook] SECURITY: Paid payment piPaymentId mismatch - rejecting")
        return new Response(JSON.stringify({ error: "Payment validation failed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
    }

    // Validate canonical payment against Redis record - continue requiring pending for all other records
    if (true) {
      if (canonicalPayment.identifier !== identifier) {
        console.error("[Pi Webhook] SECURITY: Canonical identifier mismatch")
        return new Response(JSON.stringify({ error: "Payment validation failed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (canonicalPayment.amount !== redisPayment.amount) {
        console.error("[Pi Webhook] SECURITY: Amount mismatch with canonical payment")
        return new Response(JSON.stringify({ error: "Payment validation failed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (canonicalPayment.direction !== "user_to_app") {
        console.error("[Pi Webhook] SECURITY: Invalid payment direction:", canonicalPayment.direction)
        return new Response(JSON.stringify({ error: "Invalid payment direction" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (canonicalPayment.status?.cancelled || canonicalPayment.status?.user_cancelled) {
        console.error("[Pi Webhook] SECURITY: Payment is cancelled")
        return new Response(JSON.stringify({ error: "Payment is cancelled" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (redisPayment.status?.toLowerCase() !== "pending") {
        console.error("[Pi Webhook] SECURITY: Redis payment is not pending:", redisPayment.status)
        return new Response(JSON.stringify({ error: "Invalid payment status" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
    } else {
      console.warn("[Pi Webhook] No Redis payment record found - proceeding with canonical validation")
    }

    // Call Pi /approve endpoint
    const approvalResponse = await fetch(
      `https://api.minepi.com/v2/payments/${identifier}/approve`,
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
        console.log("[Pi Webhook] ✓ Payment already approved on Pi side")
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

    // SECURITY: After /approve (including already_approved), refetch Pi and revalidate before caching
    console.log("[Pi Webhook] Refetching Pi payment to verify developer_approved...")
    const piRefetchResponse = await fetch(
      `https://api.minepi.com/v2/payments/${identifier}`,
      {
        method: "GET",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
      },
    )

    if (!piRefetchResponse.ok) {
      console.error("[Pi Webhook] Failed to refetch Pi payment after approval:", piRefetchResponse.status)
      return new Response(JSON.stringify({ error: "Payment verification failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    const refetchedPayment = await piRefetchResponse.json()

    // Revalidate paymentId, amount, direction, non-cancelled state, and developer_approved
    if (refetchedPayment.metadata?.paymentId !== paymentId) {
      console.error("[Pi Webhook] SECURITY: Refetched paymentId mismatch")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (refetchedPayment.amount !== canonicalPayment.amount) {
      console.error("[Pi Webhook] SECURITY: Amount changed after approval")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (refetchedPayment.direction !== "user_to_app") {
      console.error("[Pi Webhook] SECURITY: Direction changed after approval")
      return new Response(JSON.stringify({ error: "Invalid payment direction" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (refetchedPayment.status?.cancelled || refetchedPayment.status?.user_cancelled) {
      console.error("[Pi Webhook] SECURITY: Payment cancelled after approval")
      return new Response(JSON.stringify({ error: "Payment is cancelled" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (!refetchedPayment.status?.developer_approved) {
      console.error("[Pi Webhook] SECURITY: developer_approved is false after approval call")
      return new Response(JSON.stringify({ error: "Approval not confirmed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    console.log("[Pi Webhook] ✓ Post-approval validation passed - developer_approved: true")

    // Store context only from verified Pi response
    if (isRedisConfigured) {
      try {
        const approvalCacheKey = `pi:approval:${identifier}`
        await redis.set(approvalCacheKey, "approved", { ex: 86400 }) // Cache for 24 hours
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
