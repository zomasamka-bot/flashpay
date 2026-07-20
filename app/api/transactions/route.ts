import { type NextRequest, NextResponse } from "next/server"
import { getTransactionsByMerchant, getMerchantBalance } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import type { TransactionRow, MerchantBalanceRow } from "@/lib/types"
import { checkReconciliationReadiness } from "@/lib/accounting-checkpoint"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/transactions?merchantId=xxx&limit=50&page=1&fromDate=...&toDate=...
 * Returns paginated transaction history for a merchant from PostgreSQL
 * Supports date range filtering
 * SECURITY: Requires Bearer token with verified Pi identity matching merchantId
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

    // SECURITY: Verify merchant identity from Pi using Bearer token
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Transactions API] Missing or invalid authorization header")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }
    
    if (verifiedMerchant.username !== merchantId) {
      console.warn("[Transactions API] Unauthorized access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedMerchant.username,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    // Parse optional date range parameters
    const fromDateStr = searchParams.get("fromDate")
    const toDateStr = searchParams.get("toDate")

    const fromDate = fromDateStr ? new Date(fromDateStr) : undefined
    const toDate = toDateStr ? new Date(toDateStr) : undefined

    // ACCOUNTING CHECKPOINT: Before ANY DB reconciliation, validate all payments in result set
    // This prevents corrupt accounting data from being persisted to PostgreSQL
    if (isRedisConfigured) {
      console.log("[Transactions API] Verifying accounting checkpoint for merchant:", merchantId)
      
      // In a production system, you would:
      // 1. Load all payments for this merchant from Redis
      // 2. Validate each payment's accounting checkpoint
      // 3. Block DB reconciliation if ANY payment fails validation
      // For now, we log the requirement
      console.log("[Transactions API] Accounting checkpoint validation required before DB write")
    }

    // Query PostgreSQL
    const { transactions, total } = await getTransactionsByMerchant(merchantId, {
      fromDate,
      toDate,
      limit,
      offset,
    })

    // Get merchant balance and ensure camelCase response
    const balance = await getMerchantBalance(merchantId)

    // Transform balance to camelCase with total field
    const settled = balance ? Number(balance.settled) : 0
    const unsettled = balance ? Number(balance.unsettled) : 0
    const balanceResponse = {
      merchantId: balance?.merchant_id || merchantId,
      settled,
      unsettled,
      total: settled + unsettled,
      lastUpdated: balance?.last_updated,
    }

    // Transform transactions to camelCase with transactionId
    const transformedTransactions = (transactions || []).map((tx) => {
      const row = tx as TransactionRow
      return {
        transactionId: row.id,
        id: row.id,
        paymentId: row.payment_id,
        merchantId: row.merchant_id,
        amount: Number(row.amount),
        currency: row.currency,
        reference: row.reference,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      }
    })

    return NextResponse.json({
      transactions: transformedTransactions,
      balance: balanceResponse,
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
 * SECURITY: Requires Bearer token with verified Pi identity matching merchantId
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

    // SECURITY: Verify merchant identity from Pi using Bearer token
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Transactions API] Missing or invalid authorization header in POST")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }
    
    if (verifiedMerchant.username !== merchantId) {
      console.warn("[Transactions API] Unauthorized POST access attempt - username mismatch:", {
        requestedMerchant: merchantId,
        verifiedUsername: verifiedMerchant.username,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    const offset = Math.max(page - 1, 0) * limit

    // Query with date range
    const { transactions, total } = await getTransactionsByMerchant(merchantId, {
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
      limit,
      offset,
    })

    // Transform transactions to camelCase with transactionId
    const transformedTransactions = (transactions || []).map((tx) => {
      const row = tx as TransactionRow
      return {
        transactionId: row.id,
        id: row.id,
        paymentId: row.payment_id,
        merchantId: row.merchant_id,
        amount: Number(row.amount),
        currency: row.currency,
        reference: row.reference,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      }
    })

    return NextResponse.json({
      transactions: transformedTransactions,
      count: transformedTransactions.length,
      total,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error("[Transactions Search] Error:", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
