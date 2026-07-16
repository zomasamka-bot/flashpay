import { type NextRequest, NextResponse } from "next/server"
import { getReceipt } from "@/lib/db"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import type { ReceiptRow } from "@/lib/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/receipts/[transactionId]
 * Returns complete receipt details from PostgreSQL
 * Receipt includes: amount, date, merchant, payer, transaction ID, blockchain txid
 * SECURITY: Requires Bearer token with verified Pi identity matching merchant_id
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    return NextResponse.json(
      { error: "Transaction storage not configured" },
      { status: 503 }
    )
  }

  try {
    const { id: transactionId } = await params

    if (!transactionId) {
      return NextResponse.json({ error: "Transaction ID required" }, { status: 400 })
    }

    // SECURITY: Verify merchant identity matches receipt owner (do this first)
    const authHeader = request.headers.get("authorization")
    const verifiedMerchant = await authorizeFromHeader(authHeader)
    
    if (!verifiedMerchant) {
      console.warn("[Receipts API] Missing or invalid authorization header")
      return NextResponse.json(
        { error: "Unauthorized - missing authorization" },
        { status: 401 }
      )
    }

    const receipt = await getReceipt(transactionId)

    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
    }

    // Verify merchant owns this receipt
    if (verifiedMerchant.username !== receipt.merchant_id) {
      console.warn("[Receipts API] Unauthorized access attempt - username mismatch:", {
        verifiedUsername: verifiedMerchant.username,
        receiptMerchantId: receipt.merchant_id,
      })
      return NextResponse.json(
        { error: "Unauthorized - merchant identity verification failed" },
        { status: 403 }
      )
    }

    // Transform receipt to exact expected shape with nested data
    const transformedReceipt = {
      id: receipt.id,
      transactionId: receipt.transaction_id,
      reference: receipt.reference,
      amount: Number(receipt.amount),
      currency: receipt.currency || 'π',
      timestamp: receipt.timestamp,
      txid: receipt.txid,
      status: 'COMPLETED',
      description: receipt.description,
      merchant: {
        name: verifiedMerchant.username,
        id: receipt.merchant_id,
      },
      payer: {
        username: receipt.payer_username,
        address: receipt.payer_address,
      },
      u2aIdentifier: receipt.u2a_identifier,
      u2aTxid: receipt.u2a_txid,
      a2uIdentifier: receipt.a2u_identifier,
      a2uTxid: receipt.a2u_txid,
      createdAt: receipt.created_at,
    }

    return NextResponse.json(transformedReceipt)
  } catch (error) {
    console.error("[Receipts API] Error:", error)
    return NextResponse.json({ error: "Failed to fetch receipt" }, { status: 500 })
  }
}
