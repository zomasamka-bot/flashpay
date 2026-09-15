import { NextRequest, NextResponse } from "next/server"

import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function nonNegativeInteger(value: unknown): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function nonNegativeNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) {
    const error =
      auth.status === 500 ? "Owner verification not configured" :
      auth.status === 503 ? "Owner verification unavailable" :
      "Unauthorized"
    return NextResponse.json({ error }, { status: auth.status })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Platform overview unavailable", reason: "database_unavailable" }, { status: 503 })
  }

  const asOf = new Date().toISOString()
  const rows = await query(
    `SELECT
       COUNT(DISTINCT merchant_uid) AS total_merchants,
       COUNT(DISTINCT merchant_uid) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS active_merchants,
       COUNT(*) AS total_payments,
       COALESCE(SUM(amount), 0) AS total_volume
     FROM transactions`
  )

  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) {
    return NextResponse.json({ error: "Platform overview unavailable", reason: "database_read_failed", asOf }, { status: 503 })
  }

  const row = rows[0] as Record<string, unknown>
  const totalMerchants = nonNegativeInteger(row.total_merchants)
  const activeMerchants = nonNegativeInteger(row.active_merchants)
  const totalPayments = nonNegativeInteger(row.total_payments)
  const totalVolume = nonNegativeNumber(row.total_volume)

  if (totalMerchants === null || activeMerchants === null || totalPayments === null || totalVolume === null) {
    return NextResponse.json({ error: "Platform overview unavailable", reason: "invalid_read_model", asOf }, { status: 503 })
  }

  return NextResponse.json(
    {
      overview: { totalMerchants, activeMerchants, totalPayments, totalVolume },
      asOf,
      source: "postgres_transactions",
      activeWindowDays: 30,
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
