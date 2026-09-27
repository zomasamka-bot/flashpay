import { createHmac, timingSafeEqual } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import { serverConfig } from "@/lib/server-config"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const TTL_MS = 90_000
const PURPOSE = "flashpay-pi-entry-v1"

function signature(payload: string) {
  return createHmac("sha256", serverConfig.a2uInternalSecret).update(`${PURPOSE}:${payload}`).digest("base64url")
}
function issue(paymentId: string) {
  const exp = Date.now() + TTL_MS
  const payload = Buffer.from(JSON.stringify({ paymentId, exp })).toString("base64url")
  return { token: `${payload}.${signature(payload)}`, expiresAt: new Date(exp).toISOString() }
}
function verify(paymentId: string, token: string) {
  const [payload, supplied] = token.split(".")
  if (!payload || !supplied) return false
  const expected = signature(payload)
  const a = Buffer.from(supplied); const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return decoded?.paymentId === paymentId && Number.isFinite(decoded?.exp) && decoded.exp >= Date.now() && decoded.exp <= Date.now() + TTL_MS + 5_000
  } catch { return false }
}
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId.trim() : ""
    const action = body?.action === "verify" ? "verify" : "issue"
    if (!paymentId) return NextResponse.json({ error: "Missing paymentId" }, { status: 400 })
    if (action === "issue") {
      const result = issue(paymentId)
      console.log("[DR89 PI ENTRY] token issued", { paymentId, expiresAt: result.expiresAt })
      return NextResponse.json({ success: true, ...result })
    }
    const token = typeof body?.token === "string" ? body.token : ""
    const valid = verify(paymentId, token)
    console.log("[DR89 PI ENTRY] token verified", { paymentId, valid })
    return valid ? NextResponse.json({ success: true }) : NextResponse.json({ error: "Invalid or expired Pi entry", code: "PI_ENTRY_INVALID" }, { status: 409 })
  } catch {
    return NextResponse.json({ error: "Pi entry authority unavailable", code: "PI_ENTRY_INDETERMINATE" }, { status: 503 })
  }
}
