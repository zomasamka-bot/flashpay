/**
 * ============================================================================
 * OWNER UID VERIFICATION ENDPOINT (ISOLATED)
 * ============================================================================
 *
 * This endpoint is COMPLETELY SEPARATE from payment processing.
 * It only verifies and stores owner UID information.
 *
 * ISOLATION GUARANTEE:
 * - No payment processing
 * - No database modifications (except owner store)
 * - No interaction with payment APIs
 * - Read-only for verification purposes
 */

import { NextRequest, NextResponse } from "next/server"
import { config } from "@/lib/config"

export async function POST(request: NextRequest) {
  try {
    const { uid, accessToken } = await request.json()

    // Validate input
    if (!uid || typeof uid !== "string") {
      return NextResponse.json(
        { success: false, error: "Invalid UID" },
        { status: 400 }
      )
    }

    if (!accessToken || typeof accessToken !== "string") {
      return NextResponse.json(
        { success: false, error: "Invalid access token" },
        { status: 400 }
      )
    }

    // Verify owner UID is configured
    if (!config.isOwnerConfigured || !config.ownerUid) {
      return NextResponse.json(
        { success: false, error: "Owner verification not configured" },
        { status: 500 }
      )
    }

    // Verify provided UID exactly matches configured owner UID
    if (uid !== config.ownerUid) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 }
      )
    }

    const walletAddress = `${uid.substring(0, 8)}...${uid.substring(uid.length - 8)}`

    return NextResponse.json({
      success: true,
      walletAddress,
      isOwner: true,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error"
    console.error("[owner-verify-uid] Error:", errorMsg)

    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    )
  }
}
