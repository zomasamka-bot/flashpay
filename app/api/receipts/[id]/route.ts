import { type NextRequest, NextResponse } from "next/server"
import { getReceipt } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * GET /api/receipts/[transactionId]
 * Returns complete receipt details from PostgreSQL
 * Receipt includes: amount, date, merchant, payer, transaction ID, blockchain txid
 */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    return NextResponse.json(
      { error: "Transaction storage not configured" },
      { status: 503 }
    )
  }

  try {
    const { id: transactionId } = params

    if (!transactionId) {
      return NextResponse.json({ error: "Transaction ID required" }, { status: 400 })
    }

    const receipt = await getReceipt(transactionId)

    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found" }, { status: 404 })
    }

    return NextResponse.json(receipt)
  } catch (error) {
    console.error("[Receipts API] Error:", error)
    return NextResponse.json({ error: "Failed to fetch receipt" }, { status: 500 })
  }
}
