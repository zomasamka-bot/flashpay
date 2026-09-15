/**
 * System control API routes.
 * Endpoints to toggle kill switch and manage system state.
 * These routes are called by the Control Panel.
 * OWNER-ONLY: All endpoints require owner UID verification.
 */

import { NextRequest, NextResponse } from "next/server"
import { readSystemState, enableKillSwitch, disableKillSwitch, resetSystemState } from "@/lib/system-control"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

/**
 * GET /api/control/system
 * Fetch current system state.
 * Owner-only access required.
 * Returns default "active" state if Redis is not available.
 */
export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) {
    const error =
      auth.status === 500 ? "Owner verification not configured" :
      auth.status === 503 ? "Owner verification unavailable" :
      "Unauthorized"
    return NextResponse.json({ error }, { status: auth.status })
  }

  const result = await readSystemState()
  if (!result.ok) {
    return NextResponse.json(
      { error: "System control state unavailable", reason: result.reason },
      { status: 503, headers: { "Cache-Control": "no-cache, no-store, must-revalidate" } }
    )
  }

  return NextResponse.json(
    { ...result.state, stateSource: result.source },
    { status: 200, headers: { "Cache-Control": "no-cache, no-store, must-revalidate" } }
  )
}

/**
 * POST /api/control/system
 * Toggle kill switch.
 * OWNER-ONLY: This endpoint requires owner UID verification.
 * Body: { action: "enable" | "disable" | "reset", message?: string, ownerUid?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
    if (!auth.ok) {
      const error =
        auth.status === 500 ? "Owner verification not configured" :
        auth.status === 503 ? "Owner verification unavailable" :
        "Unauthorized"
      return NextResponse.json({ error }, { status: auth.status })
    }

    const { action, message } = await request.json()

    if (!["enable", "disable", "reset"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Must be 'enable', 'disable', or 'reset'." },
        { status: 400 }
      )
    }

    let newState
    switch (action) {
      case "enable":
        newState = await enableKillSwitch(message, auth.uid)
        break
      case "disable":
        newState = await disableKillSwitch(auth.uid)
        break
      case "reset":
        newState = await resetSystemState(auth.uid)
        break
    }

    return NextResponse.json({
      success: true,
      state: newState,
      message: `Kill switch ${action === "enable" ? "ENABLED" : action === "disable" ? "DISABLED" : "RESET"}`,
    })
  } catch (error) {
    console.error("[API] Failed to update system state:", error)
    return NextResponse.json(
      { error: "Failed to update system state" },
      { status: 500 }
    )
  }
}
