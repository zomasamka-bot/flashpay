/**
 * Public, read-only availability projection for the application shell.
 *
 * IMPORTANT: the domain-control switch is currently an owner-facing staging
 * state only. Until the real production domain is released and explicitly
 * wired to routing/server enforcement, it MUST NOT affect application
 * availability. The authoritative application kill switch remains enforced.
 */

import { NextResponse } from "next/server"
import { readSystemState } from "@/lib/system-control"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }

export async function GET() {
  const result = await readSystemState()
  if (!result.ok) {
    // Unknown authoritative system-control state fails closed for new user activity.
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
