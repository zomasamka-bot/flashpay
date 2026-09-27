import { type NextRequest, NextResponse } from "next/server"
import { acquireSettlementU2AStartLease } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId.trim() : ""
    if (!paymentId) return NextResponse.json({ error: "Missing paymentId" }, { status: 400 })
    const lease = await acquireSettlementU2AStartLease(paymentId)
    if (lease.outcome === "ACQUIRED") return NextResponse.json({ success: true, startLeaseToken: lease.token, expiresAt: lease.expiresAt })
    if (lease.outcome === "BLOCKED") return NextResponse.json({ error: "Payment already initiated", code: "U2A_START_BLOCKED" }, { status: 409 })
    return NextResponse.json({ error: "Payment start authority unavailable", code: "U2A_START_INDETERMINATE" }, { status: 503 })
  } catch {
    return NextResponse.json({ error: "Payment start authority unavailable", code: "U2A_START_INDETERMINATE" }, { status: 503 })
  }
}
