/**
 * Public, read-only availability projection for the application shell.
 * This exposes no owner/control metadata and is never a financial authority.
 */

import { NextResponse } from "next/server"
import { readSystemState } from "@/lib/system-control"
import { readDomainControlState } from "@/lib/domain-control"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }

export async function GET() {
  const result = await readSystemState()
  const domain = await readDomainControlState()
  if (!result.ok || !domain.ok) {
    // Unknown control state fails closed for new user activity.
    return NextResponse.json(
      { available: false, reason: !result.ok ? "control_state_unavailable" : "domain_state_unavailable", message: "Service temporarily unavailable. Please try again later." },
      { status: 503, headers: NO_STORE },
    )
  }

  return NextResponse.json(
    {
      available: !result.state.killSwitchEnabled && domain.state.flashpayEnabled,
      reason: result.state.killSwitchEnabled ? "maintenance" : !domain.state.flashpayEnabled ? "domain_disabled" : "online",
      message: result.state.killSwitchEnabled
        ? (result.state.maintenanceMessage || "Maintenance in progress. Please try again later.")
        : !domain.state.flashpayEnabled
          ? "FlashPay is not currently available."
          : "",
    },
    { status: 200, headers: NO_STORE },
  )
}
