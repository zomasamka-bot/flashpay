import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/payments/history?merchantId=xxx
 * Returns persistent payment history from PostgreSQL
 * Falls back to Redis if DB is not configured
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    console.log("[Payment History] Fetching history for merchant:", merchantId)

    // Try to fetch from PostgreSQL first (persistent storage)
    const isDbConfigured = !!process.env.DATABASE_URL
    
    if (isDbConfigured) {
      try {
        console.log("[Payment History] Querying PostgreSQL for persistent payment history")
        
        const result = await query(
          `SELECT 
            t.id as transaction_id,
            t.payment_id,
            t.merchant_id,
            t.amount,
            t.created_at,
            t.status,
            r.txid,
            r.timestamp as receipt_timestamp
          FROM transactions t
          LEFT JOIN receipts r ON t.id = r.transaction_id
          WHERE t.merchant_id = $1
          ORDER BY t.created_at DESC
          LIMIT $2`,
          [merchantId, limit]
        )

        if (result && result.length > 0) {
          const payments = result.map((row: any) => ({
            id: row.payment_id,
            merchantId: row.merchant_id,
            amount: parseFloat(row.amount),
            status: row.status || "PAID",
            createdAt: row.created_at,
            txid: row.txid,
            transactionId: row.transaction_id,
            paidAt: row.created_at, // transactions are only saved after payment completes
          }))

          console.log("[Payment History] Found", payments.length, "payments in PostgreSQL")
          
          return NextResponse.json({
            payments,
            total: payments.length,
            source: "postgresql",
          })
        }
      } catch (dbError) {
        console.warn("[Payment History] PostgreSQL query failed, will try Redis:", dbError)
      }
    }

    // Fallback to Redis if DB is not configured or query failed
    console.log("[Payment History] Falling back to Redis")
    
    const { redis, isRedisConfigured } = await import("@/lib/redis")
    
    if (!isRedisConfigured) {
      return NextResponse.json({
        payments: [],
        total: 0,
        source: "none",
        message: "No persistent storage configured",
      })
    }

    // Get all payment keys from Redis
    const paymentKeys = await redis.keys("payment:*")
    
    if (!paymentKeys || paymentKeys.length === 0) {
      return NextResponse.json({
        payments: [],
        total: 0,
        source: "redis",
      })
    }

    // Fetch all payments and filter by merchantId
    const payments: any[] = []
    
    for (const key of paymentKeys) {
      try {
        const data = await redis.get(key)
        if (!data) continue

        const payment = typeof data === "string" ? JSON.parse(data) : data

        // Filter by merchantId
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
      } catch (error) {
        console.error("[Payment History] Error parsing payment from key:", key, error)
        continue
      }
    }

    // Sort by created date descending
    payments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    // Apply limit
    const limitedPayments = payments.slice(0, limit)

    console.log("[Payment History] Returning", limitedPayments.length, "payments from Redis for merchant", merchantId)

    return NextResponse.json({
      payments: limitedPayments,
      total: payments.length,
      source: "redis",
    })
  } catch (error) {
    console.error("[Payment History] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payment history" },
      { status: 500 }
    )
  }
}
