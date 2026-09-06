import "server-only"

import { timingSafeEqual } from "crypto"
import { NextResponse } from "next/server"
import { getRefundReadiness } from "@/lib/refund-readiness"
import { serverConfig } from "@/lib/server-config"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const supplied = request.headers.get("x-refund-internal-secret")
  if (!serverConfig.refundInternalSecret || !supplied) {
    return NextResponse.json({ ready: false, checks: { authorized: false } }, { status: 401 })
  }
  const expectedBuffer = Buffer.from(serverConfig.refundInternalSecret)
  const suppliedBuffer = Buffer.from(supplied)
  if (expectedBuffer.length !== suppliedBuffer.length || timingSafeEqual(expectedBuffer, suppliedBuffer) !== true) {
    return NextResponse.json({ ready: false, checks: { authorized: false } }, { status: 401 })
  }

  const readiness = await getRefundReadiness()
  return NextResponse.json(readiness, { status: 200, headers: { "Cache-Control": "no-store" } })
}
