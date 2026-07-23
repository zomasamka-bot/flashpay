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

  // Verify merchant identity from Pi Bearer token FIRST
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

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // Verify merchant identity matches verified username BEFORE work
    if (verifiedUsername !== merchantId) {
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    // Validate limit as integer 1-1000
    const limitStr = searchParams.get("limit") || "100"
    const limitNum = parseInt(limitStr, 10)
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
      return NextResponse.json({ error: "limit must be integer 1-1000" }, { status: 400 })
    }

    // Validate dates by UTC round-trip
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")
    
    const params: any[] = [verifiedUsername]
    let paramIndex = 2

    if (fromDateStr) {
      try {
        const fromDate = new Date(fromDateStr)
        if (isNaN(fromDate.getTime())) throw new Error("invalid date")
        // Round-trip: verify format matches input
        if (fromDate.toISOString().slice(0, 10) !== fromDateStr) throw new Error("not UTC midnight")
        // fromDate inclusive
        params.push(fromDate.toISOString())
        paramIndex++
      } catch {
        return NextResponse.json({ error: "fromDate invalid UTC date" }, { status: 400 })
      }
    }

    if (toDateStr) {
      try {
        const toDate = new Date(toDateStr)
        if (isNaN(toDate.getTime())) throw new Error("invalid date")
        // Round-trip: verify format matches input
        if (toDate.toISOString().slice(0, 10) !== toDateStr) throw new Error("not UTC midnight")
        // toDate exclusive: < next-day UTC midnight
        toDate.setUTCDate(toDate.getUTCDate() + 1)
        params.push(toDate.toISOString())
        paramIndex++
      } catch {
        return NextResponse.json({ error: "toDate invalid UTC date" }, { status: 400 })
      }
    }

    // Build parameterized SQL with snake_case keys
    let sql = `
      SELECT 
        t.id,
        t.payment_id,
        t.merchant_id,
        t.amount,
        t.reference,
        t.description,
        t.status as payment_status,
        r.settlement_status,
        t.created_at,
        t.completed_at,
        r.u2a_identifier,
        r.u2a_txid,
        r.a2u_identifier,
        r.a2u_txid
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

    // Transform and validate rows
    const payments: Record<string, unknown>[] = []
    for (const row of result as Record<string, unknown>[]) {
      // Require non-empty id
      if (!row.id || typeof row.id !== "string") {
        throw new Error("Invalid row: missing or non-string id")
      }

      // Require non-empty reference
      if (!row.reference || typeof row.reference !== "string") {
        throw new Error(`Invalid row ${row.id}: missing or non-string reference`)
      }

      // Require non-empty payment_status
      if (!row.payment_status || typeof row.payment_status !== "string") {
        throw new Error(`Invalid row ${row.id}: missing or non-string payment_status`)
      }

      // Finite amount
      const amount = Number(row.amount)
      if (!isFinite(amount)) {
        throw new Error(`Invalid row ${row.id}: non-finite amount`)
      }

      // Valid created_at
      if (!row.created_at || typeof row.created_at !== "string") {
        throw new Error(`Invalid row ${row.id}: missing or non-string created_at`)
      }
      if (isNaN(new Date(row.created_at as string).getTime())) {
        throw new Error(`Invalid row ${row.id}: invalid created_at date`)
      }

      // completed_at: null or valid date
      if (row.completed_at !== null && row.completed_at !== undefined) {
        if (typeof row.completed_at !== "string") {
          throw new Error(`Invalid row ${row.id}: non-string completed_at`)
        }
        if (isNaN(new Date(row.completed_at).getTime())) {
          throw new Error(`Invalid row ${row.id}: invalid completed_at date`)
        }
      }

      // Receipt fields: null or string
      for (const field of ["u2a_identifier", "u2a_txid", "a2u_identifier", "a2u_txid"]) {
        if (row[field] !== null && row[field] !== undefined && typeof row[field] !== "string") {
          throw new Error(`Invalid row ${row.id}: ${field} must be null or string`)
        }
      }

      payments.push({
        id: row.id,
        transactionId: row.id,
        paymentId: row.payment_id,
        merchantId: row.merchant_id,
        amount,
        reference: row.reference,
        note: row.description || "",
        status: row.settlement_status ?? row.payment_status,
        paymentStatus: row.payment_status,
        settlementStatus: row.settlement_status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        piPaymentId: row.u2a_identifier,
        u2aTxid: row.u2a_txid,
        a2uPaymentId: row.a2u_identifier,
        a2uTxid: row.a2u_txid,
      })
    }

    return NextResponse.json({ payments })
  } catch (error) {
    console.error("[Merchant Payments API] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch payments" },
      { status: 500 }
    )
  }
}
