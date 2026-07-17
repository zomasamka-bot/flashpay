import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/payments/history?merchantId=xxx
 * Returns persistent payment history from PostgreSQL
 * SECURITY: Requires Bearer token with verified Pi identity
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Parse URL and limit
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // 2. Verify Bearer token
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Payment History] Missing or invalid authorization header")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }
    
    if (verifiedMerchant.username !== merchantId) {
      console.warn("[Payment History] Unauthorized access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedMerchant.username,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    console.log("[Payment History] Fetching history for verified merchant:", verifiedMerchant.username)

    // 3. Use verified username as authoritative merchant identity
    // 4. Query PostgreSQL

    // Query using verified username (not request parameter)
    const isDbConfigured = !!process.env.DATABASE_URL
    
    if (isDbConfigured) {
      try {
        console.log("[Payment History] Querying PostgreSQL for persistent payment history")
        
        const result = await query(
          `SELECT 
            t.id as transaction_id,
            t.payment_id,
            t.merchant_id,
            t.merchant_uid,
            t.amount,
            t.created_at,
            t.status,
            r.id as receipt_id,
            r.txid,
            r.currency,
            r.timestamp as receipt_timestamp,
            r.metadata,
            r.created_at as receipt_created_at
          FROM transactions t
          LEFT JOIN receipts r ON t.id = r.transaction_id
          WHERE t.merchant_id = $1
          ORDER BY t.created_at DESC
          LIMIT $2`,
          [verifiedMerchant.username, limit]
        )

        if (result && result.length > 0) {
          // Calculate total balance
          const totalAmount = result.reduce((sum: number, row: any) => sum + parseFloat(row.amount || 0), 0)
          
          const payments = result.map((row: any) => ({
            transactionId: row.transaction_id,
            id: row.payment_id,
            merchantId: row.merchant_id,
            merchantUid: row.merchant_uid,
            amount: parseFloat(row.amount),
            status: row.status === "settled_to_merchant" ? row.status : "processing",
            createdAt: row.created_at,
            receipt: row.receipt_id ? {
              id: row.receipt_id,
              transactionId: row.transaction_id,
              txid: row.txid,
              currency: row.currency,
              timestamp: row.receipt_timestamp,
              metadata: row.metadata,
              createdAt: row.receipt_created_at,
            } : null,
          }))

          console.log("[Payment History] Found", payments.length, "payments in PostgreSQL")
          
          return NextResponse.json({
            payments,
            balance: {
              total: totalAmount,
              currency: "π",
            },
            source: "postgresql",
          })
        } else {
          console.log("[Payment History] No results from PostgreSQL - will try Redis fallback")
        }
      } catch (dbError) {
        console.warn("[Payment History] PostgreSQL query failed, will try Redis:", dbError)
      }
    }

    // 5. Fallback to Redis if DB is not configured or query failed
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

    // Fetch all payments from Redis and filter by verified username
    const paymentKeys = await redis.keys("payment:*")
    const payments: any[] = []
    
    if (paymentKeys && paymentKeys.length > 0) {
      for (const key of paymentKeys) {
        try {
          const data = await redis.get(key)
          if (!data) continue

          const payment = typeof data === "string" ? JSON.parse(data) : data

          // Filter by verified username (not request parameter)
          if (payment.merchantId !== verifiedMerchant.username) continue

          payments.push({
            transactionId: payment.id,
            id: payment.id,
            merchantId: payment.merchantId,
            merchantUid: payment.merchantUid,
            amount: payment.amount,
            status: payment.status,
            createdAt: payment.createdAt,
            receipt: payment.txid ? {
              transactionId: payment.id,
              txid: payment.txid,
              currency: "π",
              timestamp: payment.paidAt,
            } : null,
          })
        } catch (error) {
          console.error("[Payment History] Error parsing payment from key:", key, error)
          continue
        }
      }

      // Sort by created date descending
      payments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }

    // Apply limit and calculate balance
    const limitedPayments = payments.slice(0, limit)
    const totalAmount = limitedPayments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0)

    console.log("[Payment History] Returning", limitedPayments.length, "payments from Redis for verified merchant:", verifiedMerchant.username)

    return NextResponse.json({
      payments: limitedPayments,
      balance: {
        total: totalAmount,
        currency: "π",
      },
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
