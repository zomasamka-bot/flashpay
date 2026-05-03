import { type NextRequest, NextResponse } from "next/server"
import { getTransactionsByMerchant, getMerchantBalance } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/transactions?merchantId=xxx&limit=50&page=1&fromDate=...&toDate=...
 * Returns paginated transaction history for a merchant from PostgreSQL
 * Supports date range filtering
 */
export async function GET(request: NextRequest) {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    return NextResponse.json(
      { error: "Transaction storage not configured" },
      { status: 503 }
    )
  }

  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get("merchantId")
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100)
    const page = Math.max(parseInt(searchParams.get("page") || "1", 10), 1)
    const offset = (page - 1) * limit

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    // Parse optional date range parameters
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")

    const fromDate = fromDateStr ? new Date(fromDateStr) : undefined
    const toDate = toDateStr ? new Date(toDateStr) : undefined

    // Query PostgreSQL
    const { transactions, total } = await getTransactionsByMerchant(merchantId, {
      fromDate,
      toDate,
      limit,
      offset,
    })

    // Get merchant balance
    const balance = await getMerchantBalance(merchantId)

    return NextResponse.json({
      transactions,
      balance,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error("[Transactions API] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch transactions" },
      { status: 500 }
    )
  }
}

/**
 * POST /api/transactions/search
 * Search transactions by date range and criteria
 */
export async function POST(request: NextRequest) {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    return NextResponse.json(
      { error: "Transaction storage not configured" },
      { status: 503 }
    )
  }

  try {
    const body = await request.json()
    const { merchantId, fromDate, toDate, limit = 50, page = 1 } = body

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    const offset = Math.max(page - 1, 0) * limit

    // Query with date range
    const { transactions, total } = await getTransactionsByMerchant(merchantId, {
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
      limit,
      offset,
    })

    return NextResponse.json({
      transactions,
      count: transactions.length,
      total,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error("[Transactions Search] Error:", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
