import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/merchant/payments?merchantId=xxx&limit=100&fromDate=...&toDate=...
 * Returns all payment requests for verified merchant
 * SECURITY: Requires Bearer token with verified Pi identity matching merchantId
 */
export async function GET(request: NextRequest) {
  // Check DATABASE_URL
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 503 }
    )
  }

  // Verify merchant identity from Pi Bearer token
  const authHeader = request.headers.get("authorization")
  const verifiedMerchant = await authorizeFromHeader(authHeader)

  if (!verifiedMerchant) {
    return NextResponse.json(
      { error: "Unauthorized - missing authorization" },
      { status: 401 }
    )
  }

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
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    // Validate and parse dates (YYYY-MM-DD only)
    const params: any[] = [verifiedUsername]
    let paramIndex = 2

    if (fromDateStr) {
      // Validate YYYY-MM-DD format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr)) {
        return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 })
      }
      // fromDate inclusive: >= fromDate 00:00:00
      params.push(`${fromDateStr}T00:00:00Z`)
      paramIndex++
    }

    if (toDateStr) {
      // Validate YYYY-MM-DD format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toDateStr)) {
        return NextResponse.json({ error: "toDate must be YYYY-MM-DD" }, { status: 400 })
      }
      // toDate: < next-day midnight
      const toDate = new Date(toDateStr)
      toDate.setDate(toDate.getDate() + 1)
      params.push(toDate.toISOString())
      paramIndex++
    }

    // Build parameterized SQL
    let sql = `
      SELECT 
        t.id,
        t.transaction_id as transactionId,
        t.payment_id as paymentId,
        t.merchant_id as merchantId,
        t.amount,
        t.reference,
        COALESCE(t.description, '') as description,
        COALESCE(r.settlement_status, t.status) as compatibility_status,
        t.status as paymentStatus,
        r.settlement_status as settlementStatus,
        t.created_at as createdAt,
        t.completed_at as completedAt,
        r.u2a_identifier as piPaymentId,
        r.u2a_txid as u2aTxid,
        r.a2u_identifier as a2uPaymentId,
        r.a2u_txid as a2uTxid
      FROM transactions t
      LEFT JOIN receipts r ON r.transaction_id = t.id
      WHERE t.merchant_id = $1
    `

    if (fromDateStr) {
      sql += ` AND t.created_at >= $${paramIndex}`
      paramIndex++
    }

    if (toDateStr) {
      sql += ` AND t.created_at < $${paramIndex}`
      paramIndex++
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${paramIndex}`
    params.push(limit)

    const result = await query(sql, params)

    if (!result) {
      return NextResponse.json(
        { error: "Database query returned null" },
        { status: 500 }
      )
    }

    // Transform rows to response format
    const payments = (result || []).map((row: any) => {
      // Validate finite numeric amount
      const amount = Number(row.amount)
      if (!isFinite(amount)) {
        throw new Error(`Invalid amount: ${row.amount}`)
      }

      return {
        id: row.id,
        transactionId: row.transactionId,
        paymentId: row.paymentId,
        merchantId: row.merchantId,
        amount,
        reference: row.reference,
        note: row.description,
        status: row.compatibility_status,
        paymentStatus: row.paymentStatus,
        settlementStatus: row.settlementStatus,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        piPaymentId: row.piPaymentId,
        u2aTxid: row.u2aTxid,
        a2uPaymentId: row.a2uPaymentId,
        a2uTxid: row.a2uTxid,
      }
    })

    return NextResponse.json({ payments })
  } catch (error) {
    console.error("[Merchant Payments API] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 }
    )
  }
}
