/**
 * Owner-only operational control API.
 * Control-plane state is never a financial authority.
 */

import { NextRequest, NextResponse } from "next/server"
import { readSystemState, enableKillSwitch, disableKillSwitch, resetSystemState } from "@/lib/system-control"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { appendOperationalAuditEvent, type OperationalAuditAction } from "@/lib/operational-audit"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }
const MAX_REASON_LENGTH = 240

type ControlAction = "enable" | "disable" | "reset"

function authError(status: 401 | 403 | 500 | 503) {
  return status === 500 ? "Owner verification not configured" :
    status === 503 ? "Owner verification unavailable" :
    "Unauthorized"
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: authError(auth.status) }, { status: auth.status, headers: NO_STORE })

  const result = await readSystemState()
  if (!result.ok) {
    return NextResponse.json(
      { error: "System control state unavailable", reason: result.reason },
      { status: 503, headers: NO_STORE }
    )
  }

  return NextResponse.json({ ...result.state, stateSource: result.source }, { status: 200, headers: NO_STORE })
}

export async function POST(request: NextRequest) {
  try {
    // Fresh server-side Pi owner verification is required for every write.
    const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
    if (!auth.ok) return NextResponse.json({ error: authError(auth.status) }, { status: auth.status, headers: NO_STORE })

    const body = await request.json() as Record<string, unknown>
    const action = body.action
    if (action !== "enable" && action !== "disable" && action !== "reset") {
      return NextResponse.json({ error: "Invalid control action" }, { status: 400, headers: NO_STORE })
    }

    const reason = typeof body.reason === "string" ? body.reason.trim() : ""
    if (!reason || reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: `Operational reason is required (1-${MAX_REASON_LENGTH} characters)` },
        { status: 400, headers: NO_STORE }
      )
    }

    const expectedRevision = body.expectedRevision
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: "A valid expectedRevision is required" }, { status: 400, headers: NO_STORE })
    }

    const message = typeof body.message === "string" ? body.message.trim().slice(0, 240) : undefined
    const requestId = request.headers.get("x-vercel-id") || crypto.randomUUID()

    // Canonical reread immediately before the write. Stale control-panel writes fail closed.
    const previous = await readSystemState()
    if (!previous.ok) {
      return NextResponse.json(
        { error: "System control state unavailable", reason: previous.reason, requestId },
        { status: 503, headers: NO_STORE }
      )
    }
    if (previous.state.revision !== expectedRevision) {
      return NextResponse.json(
        { error: "Control state changed. Refresh before retrying.", code: "STALE_CONTROL_REVISION", state: previous.state, requestId },
        { status: 409, headers: NO_STORE }
      )
    }

    const typedAction = action as ControlAction
    const newState =
      typedAction === "enable"
        ? await enableKillSwitch(message, auth.uid, expectedRevision)
        : typedAction === "disable"
          ? await disableKillSwitch(auth.uid, expectedRevision)
          : await resetSystemState(auth.uid, expectedRevision)

    try {
      await appendOperationalAuditEvent({
        action: `control.${typedAction}` as OperationalAuditAction,
        actorUid: auth.uid,
        requestId,
        previousRevision: previous.state.revision,
        resultingRevision: newState.revision,
        previousEnabled: previous.state.killSwitchEnabled,
        resultingEnabled: newState.killSwitchEnabled,
        reason,
      })
    } catch (auditError) {
      console.error("[API] Control state changed but audit persistence failed:", auditError)
      return NextResponse.json(
        { error: "Control state changed but audit persistence is uncertain", requestId },
        { status: 503, headers: NO_STORE }
      )
    }

    const responseMessage = typedAction === "enable"
      ? "Kill switch ACTIVATED"
      : typedAction === "disable"
        ? "Kill switch DEACTIVATED"
        : "Control defaults RESTORED"

    return NextResponse.json({ success: true, state: newState, requestId, message: responseMessage }, { headers: NO_STORE })
  } catch (error) {
    console.error("[API] Failed to update system state:", error)
    return NextResponse.json({ error: "Failed to update system state" }, { status: 500, headers: NO_STORE })
  }
}
