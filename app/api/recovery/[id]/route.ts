import { type NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { executeA2URecovery } from "@/lib/a2u-recovery-service"

/**
 * INTERNAL-ONLY Server recovery endpoint.
 * 
 * SECURITY BOUNDARY: This endpoint is NOT for client use.
 * - NEVER call from client code (lib/operations.ts, frontend, etc.)
 * - ONLY called from other server-side API routes (e.g., /api/pi/complete)
 * - ONLY called with x-flashpay-internal-secret header (server-to-server)
 * - No user-facing authentication - use internal server secret only
 * 
 * AUTHORIZATION:
 * - Requires x-flashpay-internal-secret header (server-to-server only)
 * - Fail-closed: no secret = 403 Forbidden
 * - Buffer length mismatch = 403 Forbidden (prevents timing inference)
 * - timingSafeEqual boolean result MUST be evaluated (not ignored)
 * - No fallback to client-provided credentials
 * 
 * DELEGATES to executeA2URecovery() which implements PRECISE RECOVERY ORDER:
 * 1. settled_to_merchant - return stored success only
 * 2. requiresDbReconciliation + a2uTxid - DB-only recovery
 * 3. settlement_pending + piCompletionPending - retry only Pi /complete
 * 4. piCompleted + DB pending - DB-only recovery
 * 5. settlement_failed - never restart Horizon if a2uTxid/horizonSuccessFlag exists
 * 
 * CRITICAL RULES:
 * - DB reconciliation checked BEFORE generic settlement_pending
 * - Never restart Horizon when identifiers exist
 * - Only use trusted Redis data for DB reconciliation
 * - Client must NEVER call this endpoint
 * - Client terminal states (requiresDbReconciliation, piCompleted+dbPending) block client recovery
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: paymentId } = await params

    console.log("[API Recovery] POST /api/recovery/[id] called for:", paymentId)

    // AUTHORIZATION: Verify internal secret (fail-closed, server-to-server only)
    const providedSecret = request.headers.get("x-flashpay-internal-secret")
    
    if (!providedSecret || !serverConfig.a2uInternalSecret) {
      console.error("[API Recovery] ❌ Missing internal secret header")
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 }
      )
    }

    // Timing-safe comparison with proper buffer length check
    try {
      const secretBuffer = Buffer.from(serverConfig.a2uInternalSecret)
      const providedBuffer = Buffer.from(providedSecret)
      
      // CRITICAL: Reject if buffer lengths differ (prevent early exit inference)
      if (secretBuffer.length !== providedBuffer.length) {
        console.error("[API Recovery] ❌ Secret buffer length mismatch")
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 403 }
        )
      }
      
      // Timing-safe comparison - MUST evaluate boolean return value
      const isEqual = timingSafeEqual(secretBuffer, providedBuffer)
      if (!isEqual) {
        console.error("[API Recovery] ❌ Secret validation failed - buffers not equal")
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 403 }
        )
      }
    } catch (error) {
      console.error("[API Recovery] ❌ Timing-safe comparison threw error:", error)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 403 }
      )
    }

    if (!isRedisConfigured) {
      return NextResponse.json(
        { error: "Redis not configured" },
        { status: 500 }
      )
    }

    // DELEGATE to authoritative A2U recovery service
    // This implements precise state ordering with DB reconciliation before settlement_pending
    const result = await executeA2URecovery(paymentId)

    // Map recovery result to HTTP response
    switch (result.status) {
      case "success":
        // State 1: already settled, return success
        return NextResponse.json({
          status: "settled_to_merchant",
          u2aTxid: result.details?.u2aTxid,
          a2uTxid: result.details?.a2uTxid,
        })

      case "db_reconciled":
        // States 2 & 4: DB reconciliation succeeded, return canonical response
        const canonicalResponse = await require("@/lib/a2u-response").buildA2USuccessResponse(paymentId)
        if (!canonicalResponse) {
          return NextResponse.json(
            { error: "Response building failed - data corruption detected" },
            { status: 500 }
          )
        }
        return NextResponse.json(canonicalResponse)

      case "pending_pi_complete":
        // State 3: settlement_pending, client should retry /api/pi/complete
        return NextResponse.json(
          { error: "Retry Pi /complete endpoint from client" },
          { status: 400 }
        )

      case "irreversible":
        // State 5: settlement_failed with identifiers, no restart possible
        return NextResponse.json(
          { error: "Irreversible settlement failure - contact support" },
          { status: 400 }
        )

      case "manual_review_required":
      default:
        // Any unrecoverable state
        return NextResponse.json(
          {
            error: result.details?.error || "Unable to determine recovery action",
            status: "manual_review_required",
            paymentId,
            state: result.state,
          },
          { status: 400 }
        )
    }
  } catch (error) {
    console.error("[API Recovery] Unexpected error:", error)
    return NextResponse.json(
      { error: "Recovery endpoint error", details: String(error) },
      { status: 500 }
    )
  }
}
