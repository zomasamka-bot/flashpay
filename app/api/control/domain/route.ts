import { NextRequest, NextResponse } from "next/server"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { readDomainControlState, setFlashPayDomainEnabled, setDomainMasterUnlocked, StaleDomainControlRevisionError } from "@/lib/domain-control"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Owner authorization failed" }, { status: auth.status, headers: NO_STORE })
  const result = await readDomainControlState()
  if (!result.ok) return NextResponse.json({ error: "Domain control state unavailable", reason: result.reason }, { status: 503, headers: NO_STORE })
  return NextResponse.json(result.state, { status: 200, headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Owner authorization failed" }, { status: auth.status, headers: NO_STORE })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE }) }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE })
  const record = body as Record<string, unknown>
  const operation = record.operation === "master" ? "master" : "domain"
  if (operation === "domain" && typeof record.enabled !== "boolean") return NextResponse.json({ error: "enabled must be boolean" }, { status: 400, headers: NO_STORE })
  if (operation === "master" && typeof record.masterUnlocked !== "boolean") return NextResponse.json({ error: "masterUnlocked must be boolean" }, { status: 400, headers: NO_STORE })
  const expectedRevision = record.expectedRevision
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return NextResponse.json({ error: "A valid expectedRevision is required" }, { status: 400, headers: NO_STORE })
  try {
    const previous = await readDomainControlState()
    if (!previous.ok) return NextResponse.json({ error: "Domain control state unavailable", reason: previous.reason }, { status: 503, headers: NO_STORE })
    if (previous.state.revision !== expectedRevision) return NextResponse.json({ error: "Domain state changed. Refresh before retrying.", code: "STALE_DOMAIN_REVISION", state: previous.state }, { status: 409, headers: NO_STORE })
    const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID()
    const auditReason = operation === "master" ? "Domain control master lock" : "FlashPay domain availability control"
    const state = operation === "master"
      ? await setDomainMasterUnlocked(record.masterUnlocked as boolean, auth.uid, expectedRevision, { requestId, reason: auditReason })
      : await setFlashPayDomainEnabled(record.enabled as boolean, auth.uid, expectedRevision, { requestId, reason: auditReason })
    return NextResponse.json({ success: true, state, requestId }, { status: 200, headers: NO_STORE })
  } catch (error) {
    if (error instanceof StaleDomainControlRevisionError) {
      const current = await readDomainControlState()
      return NextResponse.json({ error: "Domain state changed. Refresh before retrying.", code: "STALE_DOMAIN_REVISION", state: current.ok ? current.state : undefined }, { status: 409, headers: NO_STORE })
    }
    console.error("[Domain Control] Update failed:", error)
    return NextResponse.json({ error: "Failed to update domain control state" }, { status: 500, headers: NO_STORE })
  }
}
