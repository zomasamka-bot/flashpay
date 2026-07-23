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
  const { searchParams } = new URL(request.url)
  const merchantId = searchParams.get("merchantId")

  if (!merchantId) {
    return NextResponse.json({ error: "merchantId required" }, { status: 400 })
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

  // Require verifiedUsername===merchantId
  if (verifiedUsername !== merchantId) {
    return NextResponse.json(
      { error: "Unauthorized - merchant identity verification failed" },
      { status: 403 }
    )
  }

  // Check DATABASE_URL after auth
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 503 }
    )
  }

  try {
    // Validate limit as integer 1-1000
    const limitNum = Number(searchParams.get("limit") ?? "100")
    if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 1000) {
      return NextResponse.json({ error: "limit must be integer 1-1000" }, { status: 400 })
    }

    // Validate dates by YYYY-MM-DD regex and UTC round-trip
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")

    let fromIso: string | null = null
    let toIso: string | null = null

    if (fromDateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr)) {
        return NextResponse.json({ error: "fromDate must be YYYY-MM-DD" }, { status: 400 })
      }
      const fromDate = new Date(`${fromDateStr}T00:00:00.000Z`)
      if (isNaN(fromDate.getTime()) || fromDate.toISOString().slice(0, 10) !== fromDateStr) {
        return NextResponse.json({ error: "fromDate invalid UTC date" }, { status: 400 })
      }
      fromIso = fromDate.toISOString()
    }

    if (toDateStr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toDateStr)) {
        return NextResponse.json({ error: "toDate must be YYYY-MM-DD" }, { status: 400 })
      }
      const toDate = new Date(`${toDateStr}T00:00:00.000Z`)
      if (isNaN(toDate.getTime()) || toDate.toISOString().slice(0, 10) !== toDateStr) {
        return NextResponse.json({ error: "toDate invalid UTC date" }, { status: 400 })
      }
      toDate.setUTCDate(toDate.getUTCDate() + 1)
      toIso = toDate.toISOString()
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

    const params: unknown[] = [verifiedUsername]

    if (fromIso) {
      params.push(fromIso)
      sql += ` AND t.created_at >= $${params.length}`
    }

    if (toIso) {
      params.push(toIso)
      sql += ` AND t.created_at < $${params.length}`
    }

    params.push(limitNum)
    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length}`

    const result = await query(sql, params)

    if (!Array.isArray(result)) {
      return NextResponse.json(
        { error: "Database query returned non-array" },
        { status: 500 }
      )
    }

    // Transform and validate rows
    const payments: Record<string, unknown>[] = []
    for (const candidate of result) {
      // Require candidate to be non-null, non-array object
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Invalid row: null, non-object, or array")
      }

      const row = candidate as Record<string, unknown>

      // Validate trimmed id
      const id = typeof row.id === "string" ? row.id.trim() : row.id
      if (!id || typeof id !== "string") {
        throw new Error("Invalid row: missing or non-string id")
      }

      // Validate trimmed payment_id
      const paymentId = typeof row.payment_id === "string" ? row.payment_id.trim() : row.payment_id
      if (!paymentId || typeof paymentId !== "string") {
        throw new Error(`Invalid row ${id}: missing or non-string payment_id`)
      }

      // Validate trimmed merchant_id
      const merchantIdVal = typeof row.merchant_id === "string" ? row.merchant_id.trim() : row.merchant_id
      if (!merchantIdVal || typeof merchantIdVal !== "string") {
        throw new Error(`Invalid row ${id}: missing or non-string merchant_id`)
      }

      // Validate trimmed reference
      const reference = typeof row.reference === "string" ? row.reference.trim() : row.reference
      if (!reference || typeof reference !== "string") {
        throw new Error(`Invalid row ${id}: missing or non-string reference`)
      }

      // Validate trimmed payment_status
      const paymentStatus = typeof row.payment_status === "string" ? row.payment_status.trim() : row.payment_status
      if (!paymentStatus || typeof paymentStatus !== "string") {
        throw new Error(`Invalid row ${id}: missing or non-string payment_status`)
      }

      // Validate finite amount
      const amount = Number(row.amount)
      if (!isFinite(amount)) {
        throw new Error(`Invalid row ${id}: non-finite amount`)
      }

      // Require created_at to be Date|string before parsing
      if (!(row.created_at instanceof Date) && typeof row.created_at !== "string") {
        throw new Error(`Invalid row ${id}: created_at must be Date|string`)
      }
      const createdAtTime = row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at as string).getTime()
      if (isNaN(createdAtTime)) {
        throw new Error(`Invalid row ${id}: invalid created_at date`)
      }
      const createdAtIso = new Date(createdAtTime).toISOString()

      // Require completed_at to be null|Date|string before parsing
      if (row.completed_at !== null && !(row.completed_at instanceof Date) && typeof row.completed_at !== "string") {
        throw new Error(`Invalid row ${id}: completed_at must be null|Date|string`)
      }
      let completedAtIso: string | null = null
      if (row.completed_at !== null && row.completed_at !== undefined) {
        const completedAtTime = row.completed_at instanceof Date ? row.completed_at.getTime() : new Date(row.completed_at as string).getTime()
        if (isNaN(completedAtTime)) {
          throw new Error(`Invalid row ${id}: invalid completed_at date`)
        }
        completedAtIso = new Date(completedAtTime).toISOString()
      }

      // Require description, settlement_status, u2a_identifier, u2a_txid, a2u_identifier, a2u_txid to be exactly null|string
      if (!("description" in row)) {
        throw new Error(`Invalid row ${id}: description field missing`)
      }
      if (row.description !== null && typeof row.description !== "string") {
        throw new Error(`Invalid row ${id}: description must be exactly null|string`)
      }

      if (!("settlement_status" in row)) {
        throw new Error(`Invalid row ${id}: settlement_status field missing`)
      }
      if (row.settlement_status !== null && typeof row.settlement_status !== "string") {
        throw new Error(`Invalid row ${id}: settlement_status must be exactly null|string`)
      }

      for (const field of ["u2a_identifier", "u2a_txid", "a2u_identifier", "a2u_txid"]) {
        if (!(field in row)) {
          throw new Error(`Invalid row ${id}: ${field} field missing`)
        }
        if (row[field] !== null && typeof row[field] !== "string") {
          throw new Error(`Invalid row ${id}: ${field} must be exactly null|string`)
        }
      }

      payments.push({
        id,
        transactionId: id,
        paymentId,
        merchantId: merchantIdVal,
        amount,
        reference,
        note: row.description || "",
        status: row.settlement_status ?? paymentStatus,
        paymentStatus,
        settlementStatus: row.settlement_status,
        createdAt: createdAtIso,
        completedAt: completedAtIso,
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
