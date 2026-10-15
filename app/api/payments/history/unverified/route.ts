import { type NextRequest, NextResponse } from "next/server"
import { authorizeFromHeader } from "@/lib/merchant-auth"
import { listHistoricalMembershipWithoutCreationTime } from "@/lib/merchant-history-durable"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Read-only inventory of financially checkpointed identities lacking *original*
 * creation-time proof. Does not claim payment finality, settlement, or chronology.
 * Authorization is identical to the existing merchant history route.
 */
export async function GET(request: NextRequest) {
  const merchantId = new URL(request.url).searchParams.get("merchantId")
  if (!merchantId) return NextResponse.json({ error: "merchantId required" }, { status: 400 })
  const merchant = await authorizeFromHeader(request.headers.get("authorization"))
  if (!merchant) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (merchant.username !== merchantId) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const inventory = await listHistoricalMembershipWithoutCreationTime(merchant.username)
    const payments = inventory
    return NextResponse.json({ payments, count: payments.length,
      authority: "postgresql_checkpoint_identity_only",
      creationTimeVerified: false, financialFinalityVerified: false,
      orderedChronologically: false })
  } catch {
    return NextResponse.json({ error: "Historical membership authority unavailable" }, { status: 503 })
  }
}
