import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { processSettlementsForMerchant, getMerchantSettlementHistory, getSettlementStats } from "@/lib/settlement-service"

export const dynamic = "force-dynamic"

/**
 * POST /api/settlements/process
 * Process pending settlements for a specific merchant
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { merchantId } = body

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    console.log("[Settlement API] Processing settlements for merchant:", merchantId)

    const result = await processSettlementsForMerchant(merchantId)

    return NextResponse.json({
      success: true,
      message: "Settlements processed",
      data: result,
    })
  } catch (error) {
    console.error("[Settlement API] Error processing settlements:", error)
    return NextResponse.json(
      { error: "Failed to process settlements", details: String(error) },
      { status: 500 }
    )
  }
}

/**
 * GET /api/settlements/status
 * Get settlement status and history for merchant
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const merchantId = searchParams.get("merchantId")

    if (!merchantId) {
      return NextResponse.json({ error: "merchantId required" }, { status: 400 })
    }

    console.log("[Settlement API] Fetching settlement status for merchant:", merchantId)

    const stats = await getSettlementStats(merchantId)
    const history = await getMerchantSettlementHistory(merchantId, 50)

    return NextResponse.json({
      success: true,
      stats,
      history,
    })
  } catch (error) {
    console.error("[Settlement API] Error fetching settlement status:", error)
    return NextResponse.json(
      { error: "Failed to fetch settlement status", details: String(error) },
      { status: 500 }
    )
  }
}
