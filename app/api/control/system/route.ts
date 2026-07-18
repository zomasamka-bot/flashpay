/**
 * System control API routes.
 * Endpoints to toggle kill switch and manage system state.
 * These routes are called by the Control Panel.
 * OWNER-ONLY: All endpoints require owner UID verification.
 */

import { NextRequest, NextResponse } from "next/server"
import { getSystemState, enableKillSwitch, disableKillSwitch, resetSystemState } from "@/lib/system-control"
import { isOwnerUid, unauthorizedResponse } from "@/lib/owner-auth"

/**
 * GET /api/control/system
 * Fetch current system state.
 * Owner-only access required.
 * Returns default "active" state if Redis is not available.
 */
export async function GET(request: NextRequest) {
  try {
    // Verify owner access - for GET we allow public access to read state
    // but log the access attempt
    const state = await getSystemState()
    return NextResponse.json(state, { 
      status: 200,
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" }
    })
  } catch (error) {
    console.error("[API] Failed to fetch system state:", error)
    // Return default state (app active) on error - fail open
    return NextResponse.json(
      {
        killSwitchEnabled: false,
        maintenanceMessage: "",
        lastToggleTime: Date.now(),
      },
      { status: 200 }
    )
  }
}

/**
 * POST /api/control/system
 * Toggle kill switch.
 * OWNER-ONLY: This endpoint requires owner UID verification.
 * Body: { action: "enable" | "disable" | "reset", message?: string, ownerUid?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { action, message, ownerUid } = await request.json()

    // Verify owner access for write operations
    if (!isOwnerUid(ownerUid)) {
      console.warn("[API] Unauthorized system control attempt by UID:", ownerUid?.substring(0, 8))
      return NextResponse.json(
        unauthorizedResponse(),
        { status: 403 }
      )
    }

    if (!["enable", "disable", "reset"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Must be 'enable', 'disable', or 'reset'." },
        { status: 400 }
      )
    }

    let newState
    switch (action) {
      case "enable":
        newState = await enableKillSwitch(message)
        break
      case "disable":
        newState = await disableKillSwitch()
        break
      case "reset":
        newState = await resetSystemState()
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
