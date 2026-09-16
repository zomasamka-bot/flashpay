/**
 * Public, read-only availability projection for the application shell.
 * This exposes no owner/control metadata and is never a financial authority.
 */

import { NextResponse } from "next/server"
import { readSystemState } from "@/lib/system-control"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }

export async function GET() {
  const result = await readSystemState()
  if (!result.ok) {
    // Unknown control state fails closed for new user activity.
    return NextResponse.json(
      { available: false, reason: "control_state_unavailable", message: "Service temporarily unavailable. Please try again later." },
      { status: 503, headers: NO_STORE },
    )
  }

  return NextResponse.json(
    {
      available: !result.state.killSwitchEnabled,
      reason: result.state.killSwitchEnabled ? "maintenance" : "online",
      message: result.state.killSwitchEnabled
        ? (result.state.maintenanceMessage || "Maintenance in progress. Please try again later.")
        : "",
    },
    { status: 200, headers: NO_STORE },
  )
}
