import "server-only"

import { NextResponse } from "next/server"
import { getRefundReadiness } from "@/lib/refund-readiness"
import { serverConfig } from "@/lib/server-config"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const supplied = request.headers.get("x-refund-internal-secret")
  if (!serverConfig.refundInternalSecret || supplied !== serverConfig.refundInternalSecret) {
    return NextResponse.json({ ready: false, checks: { authorized: false } }, { status: 401 })
  }

  const readiness = await getRefundReadiness()
  return NextResponse.json(readiness, { status: 200, headers: { "Cache-Control": "no-store" } })
}
