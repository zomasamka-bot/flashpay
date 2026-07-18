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
import { publicConfig } from "@/lib/config"

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
    console.log("[owner-verify-uid] Config check:", {
      isOwnerConfigured: publicConfig.isOwnerConfigured,
      ownerUidExists: !!publicConfig.ownerUid,
      ownerUid: publicConfig.ownerUid ? publicConfig.ownerUid.substring(0, 20) + "..." : "NOT SET",
      processEnv: !!process.env.NEXT_PUBLIC_OWNER_UID,
    })

    if (!publicConfig.isOwnerConfigured || !publicConfig.ownerUid) {
      console.error("[owner-verify-uid] Config not configured:", {
        isOwnerConfigured: publicConfig.isOwnerConfigured,
        ownerUid: publicConfig.ownerUid,
      })
      return NextResponse.json(
        { success: false, error: "Owner verification not configured" },
        { status: 500 }
      )
    }

    // Verify the accessToken with Pi Network API - this is the source of truth
    let verifiedUid: string
    try {
      const piResponse = await fetch("https://api.minepi.com/v2/me", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      })

      if (!piResponse.ok) {
        return NextResponse.json(
          { success: false, error: "Invalid access token" },
          { status: 403 }
        )
      }

      const piData = await piResponse.json()

      // Extract verified UID from Pi Network response
      verifiedUid = piData.uid || piData.userId || piData.user_id || ""

      if (!verifiedUid) {
        return NextResponse.json(
          { success: false, error: "No UID in Pi Network response" },
          { status: 403 }
        )
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Pi Network verification failed"
      return NextResponse.json(
        { success: false, error: errorMsg },
        { status: 503 }
      )
    }

    // Compare verified UID from Pi Network with configured owner UID
    console.log("[owner-verify-uid] UID Comparison:", {
      verifiedUid,
      configOwnerUid: publicConfig.ownerUid,
      match: verifiedUid === publicConfig.ownerUid,
    })

    if (verifiedUid !== publicConfig.ownerUid) {
      return NextResponse.json(
        { success: false, error: "Not authorized as owner" },
        { status: 403 }
      )
    }

    const walletAddress = `${verifiedUid.substring(0, 8)}...${verifiedUid.substring(verifiedUid.length - 8)}`

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
