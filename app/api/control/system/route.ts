/**
 * System control API routes.
 * Endpoints to toggle kill switch and manage system state.
 * These routes are called by the Control Panel.
 */

import { NextRequest, NextResponse } from "next/server"
import { getSystemState, enableKillSwitch, disableKillSwitch, resetSystemState } from "@/lib/system-control"

/**
 * GET /api/control/system
 * Fetch current system state.
 * Returns default "active" state if Redis is not available.
 */
export async function GET(request: NextRequest) {
  try {
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
 * Body: { action: "enable" | "disable" | "reset", message?: string }
 */
export async function POST(request: NextRequest) {
  try {
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
