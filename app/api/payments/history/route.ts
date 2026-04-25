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
        
        // Query transactions with explicit merchantId check and data validation
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
          console.log("[Payment History] Found", result.length, "transaction records")
          
          const payments = result.map((row: any) => {
            // Validate merchantId matches
            if (row.merchant_id !== merchantId) {
              console.warn("[Payment History] Skipping row with mismatched merchantId:", {
                expected: merchantId,
                got: row.merchant_id,
                paymentId: row.payment_id,
              })
              return null
            }

            return {
              id: row.payment_id,
              merchantId: row.merchant_id,
              amount: parseFloat(row.amount),
              status: row.status || "PAID",
              createdAt: row.created_at,
              txid: row.txid,
              transactionId: row.transaction_id,
              paidAt: row.created_at, // transactions are only saved after payment completes
            }
          }).filter((p: any) => p !== null)

          console.log("[Payment History] After filtering, returning", payments.length, "payments")
          
          if (payments.length > 0) {
            console.log("[Payment History] Found", payments.length, "payments in PostgreSQL")
            return NextResponse.json({
              payments,
              total: payments.length,
              source: "postgresql",
              merchantId,
            })
          }
        }

        console.log("[Payment History] No transactions found in PostgreSQL for merchant:", merchantId)
      } catch (dbError) {
        console.warn("[Payment History] PostgreSQL query failed:", dbError)
        // Fall through to Redis fallback
      }
    }

    // Fallback to Redis if DB is not configured or query failed or returned 0 results
    console.log("[Payment History] Falling back to Redis for merchant:", merchantId)
    
    const { redis, isRedisConfigured } = await import("@/lib/redis")
    
    if (!isRedisConfigured) {
      console.log("[Payment History] No storage configured")
      return NextResponse.json({
        payments: [],
        total: 0,
        source: "none",
        message: "No persistent storage configured",
        merchantId,
      })
    }

    // Get all payment keys from Redis
    const paymentKeys = await redis.keys("payment:*")
    
    if (!paymentKeys || paymentKeys.length === 0) {
      console.log("[Payment History] No payment keys found in Redis")
      return NextResponse.json({
        payments: [],
        total: 0,
        source: "redis",
        merchantId,
      })
    }

    console.log("[Payment History] Found", paymentKeys.length, "payment keys in Redis")

    // Fetch all payments and filter by merchantId
    const payments: any[] = []
    
    for (const key of paymentKeys) {
      try {
        const data = await redis.get(key)
        if (!data) continue

        const payment = typeof data === "string" ? JSON.parse(data) : data

        // CRITICAL: Only include payments matching the requested merchantId
        if (payment.merchantId !== merchantId) {
          console.log("[Payment History] Skipping Redis payment from different merchant:", {
            paymentId: payment.id,
            expectedMerchant: merchantId,
            gotMerchant: payment.merchantId,
          })
          continue
        }

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
      merchantId,
    })
  } catch (error) {
    console.error("[Payment History] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payment history", details: String(error) },
      { status: 500 }
    )
  }
}
