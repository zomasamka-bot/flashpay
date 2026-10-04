import { type NextRequest } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { recordSettlementU2AApprovalClaimFromStartLease } from "@/lib/db"
import { consumeFinancialRateLimit } from "@/lib/server-rate-limit"

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
    const body: { identifier?: unknown; startLeaseToken?: unknown } = await request.json()
    const startLeaseToken = typeof body?.startLeaseToken === "string" ? body.startLeaseToken.trim() : ""
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : ""

    if (!identifier) {
      console.error("[Pi Webhook] Missing or invalid identifier in request")
      return new Response(JSON.stringify({ error: "Missing identifier" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    console.log("[Pi Webhook] Pi Payment ID:", identifier)

    if (!serverConfig.isPiApiKeyConfigured) {
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
          Authorization: `Key ${serverConfig.piApiKey}`,
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

    if (canonicalPayment.identifier !== identifier) {
      console.error("[Pi Webhook] SECURITY: Canonical identifier mismatch")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    // DR-24: FlashPay is deliberately Testnet-only at this release boundary.
    // A Pi Developer Portal/app-key mismatch must fail before Pi /approve or any
    // durable financial ownership transition can authorize Testnet settlement.
    if (canonicalPayment.network !== "Pi Testnet") {
      console.error("[DR-24 NETWORK BOUNDARY] canonical Pi network mismatch", { observedNetwork: typeof canonicalPayment.network === "string" ? canonicalPayment.network : "invalid" })
      return new Response(JSON.stringify({ error: "Payment network mismatch", code: "PI_NETWORK_MISMATCH" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }

    // Derive paymentId ONLY from canonical metadata
    const rawPaymentId = canonicalPayment.metadata?.paymentId
    if (typeof rawPaymentId !== "string" || rawPaymentId.length === 0 || rawPaymentId !== rawPaymentId.trim()) {
      console.error("[Pi Webhook] Missing paymentId in canonical Pi metadata")
      return new Response(JSON.stringify({ error: "Invalid payment metadata" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const paymentId = rawPaymentId

    console.log("[Pi Webhook] Our Payment ID:", paymentId)

    // R101-8: payment/identifier-scoped abuse control after canonical Pi identity
    // is known and before any Pi mutation. SDK retries retain a generous burst.
    const approvalLimit = await consumeFinancialRateLimit({
      namespace: "pi-approve", subject: `${paymentId}:${identifier}`, limit: 20, windowSeconds: 60,
    })
    if (approvalLimit.outcome === "LIMITED") {
      return new Response(JSON.stringify({ error: "Too many approval requests", code: "RATE_LIMITED" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(approvalLimit.retryAfterSeconds) } })
    }
    if (approvalLimit.outcome === "UNAVAILABLE") {
      return new Response(JSON.stringify({ error: "Approval temporarily unavailable", code: "RATE_LIMIT_UNAVAILABLE" }), { status: 503, headers: { "Content-Type": "application/json" } })
    }



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
    if (!redisPayment || redisPayment.id !== paymentId) {
      console.error("[Pi Webhook] SECURITY: No matching Redis payment record found for", paymentId)
      return new Response(JSON.stringify({ error: "Payment not found in system" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Idempotency check: Return 200 for already-paid-to-app only when piPaymentId matches identifier
    if (redisPayment.status === "paid_to_app") {
      if (redisPayment.piPaymentId === identifier) {
        console.log("[Pi Webhook] ✓ Payment already paid to app - piPaymentId matches identifier, returning 200")
        return new Response(null, { status: 200 })
      } else {
        console.error("[Pi Webhook] SECURITY: Paid payment piPaymentId mismatch - rejecting")
        return new Response(JSON.stringify({ error: "Payment validation failed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
    }

    // Validate canonical payment against Redis record - continue requiring pending for all other records.
    // DR-23: the payment-existence gate above already returned on absence; keep the
    // live validation path explicit and remove the unreachable permissive legacy branch.
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

    // R101-2: after every canonical/Redis gate but BEFORE Pi /approve, atomically
    // bind this FlashPay payment to exactly one Pi U2A identifier in PostgreSQL.
    // No secret is stored. DB uncertainty/conflict fails closed before Pi mutation.
    const merchantId = typeof redisPayment.merchantId === "string" && redisPayment.merchantId.length > 0 && redisPayment.merchantId === redisPayment.merchantId.trim() ? redisPayment.merchantId : ""
    const merchantUid = typeof redisPayment.merchantUid === "string" && redisPayment.merchantUid.length > 0 && redisPayment.merchantUid === redisPayment.merchantUid.trim() ? redisPayment.merchantUid : ""
    if (!merchantId || !merchantUid) {
      console.error("[R101-2 U2A APPROVAL CLAIM] durable identity input invalid", { paymentId })
      return new Response(JSON.stringify({ error: "Payment identity verification failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (!startLeaseToken) {
      return new Response(JSON.stringify({ error: "Payment start authority missing", code: "U2A_START_AUTHORITY_MISSING" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    const approvalClaim = await recordSettlementU2AApprovalClaimFromStartLease({
      paymentId, merchantId, merchantUid, customerAmount: redisPayment.amount, u2aIdentifier: identifier, startLeaseToken,
    })
    if (approvalClaim.outcome !== "RECORDED" && approvalClaim.outcome !== "REPLAYED") {
      console.error("[R101-2 U2A APPROVAL CLAIM] approval ownership unavailable", { paymentId, outcome: approvalClaim.outcome })
      return new Response(JSON.stringify({
        error: approvalClaim.outcome === "CONFLICT" ? "Payment validation failed" : "Payment durability unavailable",
        code: approvalClaim.outcome === "CONFLICT" ? "U2A_APPROVAL_OWNERSHIP_CONFLICT" : "U2A_APPROVAL_DURABILITY_UNAVAILABLE",
      }), {
        status: approvalClaim.outcome === "CONFLICT" ? 409 : 503,
        headers: { "Content-Type": "application/json" },
      })
    }

    // PLAN I P1: Pi /approve is an externally visible side effect. A non-2xx or
    // transport exception can be ambiguous (Pi may have applied the approval while
    // the response was lost). Attempt POST at most once, then ALWAYS reconcile by
    // exact GET before deciding success/failure. Never blindly retry /approve here.
    let approvalPostOutcome: "ok" | "already_approved" | "non_ok" | "exception" = "non_ok"
    try {
      const approvalResponse = await fetch(
        `https://api.minepi.com/v2/payments/${identifier}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Key ${serverConfig.piApiKey}`,
            "Content-Type": "application/json",
          },
        },
      )
      const approvalData = await approvalResponse.json().catch(() => ({}))
      if (approvalResponse.ok) {
        approvalPostOutcome = "ok"
        console.log("[Pi Webhook] ✓ Payment approved via Pi API")
      } else if (approvalResponse.status === 400 && approvalData.error?.message?.includes("already_approved")) {
        approvalPostOutcome = "already_approved"
        console.log("[Pi Webhook] ✓ Payment already approved on Pi side")
      } else {
        approvalPostOutcome = "non_ok"
        console.warn("[PLAN I P1] Pi /approve non-OK outcome is ambiguous; reconciling exact payment", { status: approvalResponse.status })
      }
    } catch (approvalError) {
      approvalPostOutcome = "exception"
      console.warn("[PLAN I P1] Pi /approve transport outcome is ambiguous; reconciling exact payment", approvalError)
    }

    // Mandatory exact reconciliation for every POST outcome: OK, already-approved,
    // non-OK, or transport exception. Success is derived only from canonical Pi state.
    console.log("[Pi Webhook] Refetching Pi payment to verify developer_approved...", { approvalPostOutcome })
    const piRefetchResponse = await fetch(
      `https://api.minepi.com/v2/payments/${identifier}`,
      {
        method: "GET",
        headers: {
          Authorization: `Key ${serverConfig.piApiKey}`,
          "Content-Type": "application/json",
        },
      },
    )

    if (!piRefetchResponse.ok) {
      console.error("[PLAN I P1] Exact Pi approval reconciliation unavailable", { status: piRefetchResponse.status, approvalPostOutcome })
      return new Response(JSON.stringify({ error: "Approval reconciliation unavailable", code: "PI_APPROVAL_RECONCILIATION_UNAVAILABLE" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    }

    const refetchedPayment: PiPaymentDTO = await piRefetchResponse.json()

    // Revalidate the exact identity and immutable financial attributes before
    // accepting developer_approved=true as proof of the side effect.
    if (refetchedPayment.identifier !== identifier) {
      console.error("[PLAN I P1] SECURITY: Refetched identifier mismatch")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.network !== "Pi Testnet") {
      console.error("[DR-24 NETWORK BOUNDARY] refetched Pi network mismatch", { paymentId, observedNetwork: typeof refetchedPayment.network === "string" ? refetchedPayment.network : "invalid" })
      return new Response(JSON.stringify({ error: "Payment network mismatch", code: "PI_NETWORK_MISMATCH" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.metadata?.paymentId !== paymentId) {
      console.error("[PLAN I P1] SECURITY: Refetched paymentId mismatch")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.amount !== canonicalPayment.amount || refetchedPayment.amount !== redisPayment.amount) {
      console.error("[PLAN I P1] SECURITY: Amount changed after approval")
      return new Response(JSON.stringify({ error: "Payment validation failed" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.direction !== "user_to_app") {
      console.error("[PLAN I P1] SECURITY: Direction changed after approval")
      return new Response(JSON.stringify({ error: "Invalid payment direction" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.status?.cancelled === true || refetchedPayment.status?.user_cancelled === true) {
      console.error("[PLAN I P1] SECURITY: Payment cancelled after approval")
      return new Response(JSON.stringify({ error: "Payment is cancelled" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    if (refetchedPayment.status?.developer_approved !== true) {
      console.warn("[PLAN I P1] Approval not proven by exact reconciliation", { approvalPostOutcome })
      return new Response(JSON.stringify({ error: "Approval not confirmed", code: "PI_APPROVAL_NOT_CONFIRMED" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    }

    console.log("[Pi Webhook] ✓ Post-approval exact reconciliation passed - developer_approved: true")

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
