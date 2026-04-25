import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/merchant/payments?merchantId=xxx&limit=100&fromDate=...&toDate=...
 * Returns all PAID payment requests created by a specific merchant from PostgreSQL
 * This is the SOURCE OF TRUTH for persistent payment history
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    console.log("[Merchant Payments API] Fetching PAID payments from PostgreSQL for merchant:", merchantId)

    // Build query for PostgreSQL
    let sql = `
      SELECT 
        t.payment_id as id,
        t.merchant_id as merchantId,
        t.amount,
        t.description as note,
        'paid' as status,
        t.created_at as createdAt,
        t.completed_at as paidAt,
        r.txid,
        t.id as transaction_id,
        r.timestamp as receipt_timestamp
      FROM transactions t
      LEFT JOIN receipts r ON t.id = r.transaction_id
      WHERE t.merchant_id = $1
    `
    
    const params: any[] = [merchantId]
    let paramIndex = 2

    // Add date filters if provided
    if (fromDateStr) {
      sql += ` AND t.created_at >= $${paramIndex}`
      params.push(new Date(fromDateStr).toISOString())
      paramIndex++
    }

    if (toDateStr) {
      const toDate = new Date(toDateStr)
      toDate.setHours(23, 59, 59, 999)
      sql += ` AND t.created_at <= $${paramIndex}`
      params.push(toDate.toISOString())
      paramIndex++
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${paramIndex}`
    params.push(limit)

    console.log("[Merchant Payments API] Executing PostgreSQL query with params:", { merchantId, limit })

    const result = await query(sql, params)
    const payments = result || []

    console.log("[Merchant Payments API] Found", payments.length, "payments from PostgreSQL")

    return NextResponse.json({
      payments: payments,
      total: payments.length,
      source: "PostgreSQL"
    })
  } catch (error) {
    console.error("[Merchant Payments API] Error fetching from PostgreSQL:", error)
    
    // Fallback to Redis for temporary session data
    console.warn("[Merchant Payments API] Falling back to Redis (temporary data)")
    
    const { redis, isRedisConfigured } = await import("@/lib/redis")
    
    if (!isRedisConfigured) {
      return NextResponse.json(
        { error: "Payment storage not available", payments: [], total: 0 },
        { status: 503 }
      )
    }

    try {
      const { searchParams } = new URL(request.url)
      const merchantId = searchParams.get("merchantId")
      const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)

      const paymentKeys = await redis.keys("payment:*")
      const payments: any[] = []
      
      for (const key of paymentKeys) {
        try {
          const data = await redis.get(key)
          if (!data) continue
          const payment = typeof data === "string" ? JSON.parse(data) : data
          if (payment.merchantId !== merchantId) continue
          payments.push({
            id: payment.id,
            merchantId: payment.merchantId,
            amount: payment.amount,
            note: payment.note,
            status: payment.status,
            createdAt: payment.createdAt,
            paidAt: payment.paidAt,
            txid: payment.txid,
          })
        } catch (e) {
          console.warn("[Merchant Payments API] Error parsing payment from Redis:", e)
        }
      }

      return NextResponse.json({
        payments: payments.slice(0, limit),
        total: payments.length,
        source: "Redis (temporary - no PostgreSQL)"
      })
    } catch (redisError) {
      console.error("[Merchant Payments API] Redis fallback failed:", redisError)
      return NextResponse.json(
        { error: "Failed to fetch payments", payments: [], total: 0 },
        { status: 500 }
      )
    }
  }
}
