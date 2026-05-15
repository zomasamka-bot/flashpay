import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// GET /api/emergency/clear-stuck-payment — List all pending payments blocking the system
export async function GET(request: NextRequest) {
  console.log("[Emergency] GET - Listing stuck payments")
  
  if (!isRedisConfigured) {
    return NextResponse.json(
      { error: "Redis not configured", stuckPayments: [] },
      { status: 503 }
    )
  }

  try {
    // Get all payment keys from Redis
    const allKeys = await redis.keys("payment:*")
    console.log("[Emergency] Found payment keys:", allKeys.length)
    
    const stuckPayments: any[] = []
    
    for (const key of allKeys) {
      const paymentData = await redis.get(key)
      if (paymentData) {
        const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
        if (payment.status === "pending") {
          stuckPayments.push({
            key,
            id: payment.id,
            amount: payment.amount,
            status: payment.status,
            createdAt: payment.createdAt,
            note: payment.note,
          })
        }
      }
    }
    
    console.log("[Emergency] Stuck pending payments:", stuckPayments.length)
    
    return NextResponse.json({
      success: true,
      stuckPaymentCount: stuckPayments.length,
      stuckPayments,
      message: stuckPayments.length > 0 
        ? `Found ${stuckPayments.length} stuck payment(s) - POST to clear` 
        : "No stuck payments found"
    })
  } catch (error) {
    console.error("[Emergency] Error listing payments:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

// POST /api/emergency/clear-stuck-payment — CLEAR ALL STUCK PAYMENTS
export async function POST(request: NextRequest) {
  console.log("[Emergency] POST - Clearing stuck payments")
  
  if (!isRedisConfigured) {
    return NextResponse.json(
      { error: "Redis not configured" },
      { status: 503 }
    )
  }

  try {
    // Get all payment keys from Redis
    const allKeys = await redis.keys("payment:*")
    console.log("[Emergency] Processing", allKeys.length, "payment keys")
    
    let clearedCount = 0
    const clearedPayments: string[] = []
    
    for (const key of allKeys) {
      const paymentData = await redis.get(key)
      if (paymentData) {
        const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
        
        if (payment.status === "pending") {
          // Mark as cancelled instead of deleting
          const clearedPayment = {
            ...payment,
            status: "cancelled" as const,
            cancelledAt: new Date().toISOString(),
            reason: "Emergency clear - stuck payment blocking system"
          }
          
          await redis.set(key, JSON.stringify(clearedPayment))
          clearedCount++
          clearedPayments.push(payment.id)
          console.log("[Emergency] Cleared stuck payment:", payment.id)
        }
      }
    }
    
    console.log("[Emergency] Successfully cleared", clearedCount, "stuck payments")
    
    return NextResponse.json({
      success: true,
      clearedCount,
      clearedPaymentIds: clearedPayments,
      message: clearedCount > 0 
        ? `Cleared ${clearedCount} stuck payment(s). System is now ready for new payments.`
        : "No stuck payments found to clear"
    })
  } catch (error) {
    console.error("[Emergency] Error clearing payments:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
