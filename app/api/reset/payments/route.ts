import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"

/**
 * EMERGENCY RESET ENDPOINT
 * 
 * Clears all stuck/pending payments from Redis.
 * This is a system-level operation that restores the ability to accept new payments.
 * 
 * Usage:
 * POST /api/reset/payments
 * 
 * This endpoint:
 * 1. Scans all Redis keys with pattern "payment:*"
 * 2. Deletes all stuck pending payments
 * 3. Returns count of payments cleared
 * 4. Allows new payments to flow freely
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface ResetResponse {
  success: boolean
  message: string
  paymentsCleaned?: number
  error?: string
}

export async function POST(request: NextRequest): Promise<NextResponse<ResetResponse>> {
  try {
    console.log("[RESET] Payment system reset initiated at", new Date().toISOString())

    if (!isRedisConfigured) {
      console.error("[RESET] Redis not configured - cannot clear payments")
      return NextResponse.json(
        {
          success: false,
          message: "Redis not configured",
          error: "Unable to access payment storage",
        },
        { status: 500 },
      )
    }

    // Get all payment keys from Redis
    console.log("[RESET] Scanning Redis for all payment keys...")

    // Use KEYS pattern to find all payments
    // WARNING: In production, use SCAN instead of KEYS for large datasets
    const allKeys = await redis.keys("payment:*")
    console.log("[RESET] Found", allKeys.length, "payments in Redis")

    if (allKeys.length === 0) {
      console.log("[RESET] No stuck payments found")
      return NextResponse.json(
        {
          success: true,
          message: "No stuck payments to clear",
          paymentsCleaned: 0,
        },
        { status: 200 },
      )
    }

    // Delete all stuck payments
    let deleted = 0
    for (const key of allKeys) {
      try {
        const result = await redis.del(key)
        if (result === 1) {
          deleted++
          console.log("[RESET] Deleted:", key)
        }
      } catch (delError) {
        console.error("[RESET] Failed to delete", key, ":", delError)
      }
    }

    console.log("[RESET] ✅ Successfully cleared", deleted, "stuck payments from Redis")
    console.log("[RESET] System is now ready to accept new payments")

    return NextResponse.json(
      {
        success: true,
        message: `System reset complete. Cleared ${deleted} stuck payment(s). Ready for new payments.`,
        paymentsCleaned: deleted,
      },
      { status: 200 },
    )
  } catch (error) {
    console.error("[RESET] Fatal error during reset:", error)

    return NextResponse.json(
      {
        success: false,
        message: "System reset failed",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}

// GET endpoint to check reset status
export async function GET(): Promise<NextResponse> {
  try {
    if (!isRedisConfigured) {
      return NextResponse.json(
        {
          success: false,
          message: "Redis not configured",
        },
        { status: 500 },
      )
    }

    // Check how many payments are currently stuck
    const allKeys = await redis.keys("payment:*")

    let pendingCount = 0
    let paidCount = 0
    let failedCount = 0

    for (const key of allKeys) {
      try {
        const data = await redis.get(key)
        if (data) {
          const payment = typeof data === "string" ? JSON.parse(data) : data
          if (payment.status === "pending") pendingCount++
          else if (payment.status === "paid") paidCount++
          else if (payment.status === "failed") failedCount++
        }
      } catch (err) {
        console.error("[RESET] Error reading payment:", key, err)
      }
    }

    return NextResponse.json(
      {
        success: true,
        totalPayments: allKeys.length,
        byStatus: {
          pending: pendingCount,
          paid: paidCount,
          failed: failedCount,
        },
        isBlocked: pendingCount > 0,
        message:
          pendingCount > 0
            ? `⚠️ System BLOCKED: ${pendingCount} pending payment(s) preventing new payments. Run POST /api/reset/payments to clear.`
            : "✅ System OK: Ready to accept new payments",
      },
      { status: 200 },
    )
  } catch (error) {
    console.error("[RESET] Error checking status:", error)
    return NextResponse.json(
      {
        success: false,
        message: "Status check failed",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
