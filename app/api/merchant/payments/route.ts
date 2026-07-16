import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/merchant/payments?merchantId=xxx&limit=100&fromDate=...&toDate=...
 * Returns all PAID payment requests created by a specific merchant from PostgreSQL
 * This is the SOURCE OF TRUTH for persistent payment history
 * SECURITY: Requires Bearer token with verified Pi identity matching merchantId
 */
export async function GET(request: NextRequest) {
  // SECURITY: Verify merchant identity from Pi using Bearer token FIRST (outside try/catch)
  const authHeader = request.headers.get("authorization")
  const verifiedMerchant = await authorizeFromHeader(authHeader)
  
  if (!verifiedMerchant) {
    console.warn("[Merchant Payments API] Missing or invalid authorization header")
    return NextResponse.json(
      { error: "Unauthorized - missing authorization" },
      { status: 401 }
    )
  }

  // Use verified username as authoritative merchant ID
  const verifiedUsername = verifiedMerchant.username

  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // Verify merchant identity matches verified username
    if (verifiedUsername !== merchantId) {
      console.warn("[Merchant Payments API] Unauthorized access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedUsername,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    console.log("[Merchant Payments API] Fetching PAID payments from PostgreSQL for verified merchant:", verifiedUsername)

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
    
    const params: any[] = [verifiedUsername]
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
    
    // Null or error result triggers Redis fallback
    if (!result) {
      throw new Error("Database query returned null")
    }
    
    const payments = result

    console.log("[Merchant Payments API] Found", payments.length, "payments from PostgreSQL")

    // Transform to camelCase
    const transformedPayments = (payments || []).map((p: any) => ({
      id: p.id,
      merchantId: p.merchantId,
      amount: Number(p.amount),
      note: p.note,
      status: p.status,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
      txid: p.txid,
      transactionId: p.transaction_id,
      receiptTimestamp: p.receipt_timestamp,
    }))

    // Calculate total balance from payments
    const totalBalance = transformedPayments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0)

    return NextResponse.json({
      payments: transformedPayments,
      balance: {
        total: totalBalance,
        currency: "π",
      },
      source: "PostgreSQL"
    })
  } catch (dbError) {
    console.error("[Merchant Payments API] PostgreSQL query failed:", dbError)
    
    // Fallback to Redis for temporary session data - use verified username (already obtained outside try/catch)
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
      const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 1000)

      const paymentKeys = await redis.keys("payment:*")
      const payments: any[] = []
      
      for (const key of paymentKeys) {
        try {
          const data = await redis.get(key)
          if (!data) continue
          const payment = typeof data === "string" ? JSON.parse(data) : data
          // Filter by verified username (verified before DB attempt, now outside try/catch)
          if (payment.merchantId !== verifiedUsername) continue
          payments.push({
            id: payment.id,
            merchantId: payment.merchantId,
            merchantUid: payment.merchantUid,
            amount: payment.amount,
            note: payment.note,
            status: payment.status,
            createdAt: payment.createdAt,
            paidAt: payment.paidAt,
            txid: payment.txid,
            transactionId: payment.id,
          })
        } catch (e) {
          console.warn("[Merchant Payments API] Error parsing payment from Redis:", e)
        }
      }

      // Calculate total balance
      const totalBalance = payments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0)

      return NextResponse.json({
        payments: payments.slice(0, limit),
        balance: {
          total: totalBalance,
          currency: "π",
        },
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
