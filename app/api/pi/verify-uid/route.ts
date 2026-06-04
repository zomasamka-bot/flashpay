import { type NextRequest, NextResponse } from "next/server"
import { redis } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface VerifyUidRequest {
  uid: string
  accessToken: string
  merchantId: string
}

export async function POST(request: NextRequest) {
  try {
    console.log("[Pi Verify] ===== UID VERIFICATION REQUEST =====")
    const body = (await request.json()) as VerifyUidRequest
    const { uid, accessToken, merchantId } = body

    console.log("[Pi Verify] Verifying UID:", uid.substring(0, 20) + "...")
    console.log("[Pi Verify] Merchant ID:", merchantId)

    if (!uid || !accessToken || !merchantId) {
      console.error("[Pi Verify] Missing required fields")
      return NextResponse.json(
        { error: "Missing uid, accessToken, or merchantId", verified: false },
        { status: 400 }
      )
    }

    // Call Pi /v2/me endpoint to verify the uid with the access token
    console.log("[Pi Verify] Calling Pi /v2/me to verify uid...")
    const verifyResponse = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })

    console.log("[Pi Verify] Pi /v2/me response status:", verifyResponse.status)

    if (!verifyResponse.ok) {
      const errorData = await verifyResponse.text()
      console.error("[Pi Verify] ❌ Pi /v2/me returned error")
      console.error("[Pi Verify] Status:", verifyResponse.status)
      console.error("[Pi Verify] Response:", errorData)
      return NextResponse.json(
        {
          error: "Failed to verify UID with Pi Network",
          piStatus: verifyResponse.status,
          verified: false,
        },
        { status: 401 }
      )
    }

    const verifiedUser = await verifyResponse.json()
    console.log("[Pi Verify] ✓ Pi /v2/me returned user data")
    console.log("[Pi Verify] ===== FULL /v2/me RESPONSE =====")
    console.log(JSON.stringify(verifiedUser, null, 2))
    console.log("[Pi Verify] ===== END /v2/me RESPONSE =====")
    console.log("[Pi Verify] User UID from Pi:", verifiedUser.uid)
    console.log("[Pi Verify] User username:", verifiedUser.username)
    console.log("[Pi Verify] User scopes:", verifiedUser.scopes)
    console.log("[Pi Verify] User wallet address:", verifiedUser.wallet_address)

    // The verified uid from Pi /v2/me is what we should use for A2U
    const verifiedUid = verifiedUser.uid
    if (verifiedUid !== uid) {
      console.warn("[Pi Verify] ⚠️ UID mismatch!")
      console.warn("[Pi Verify] Original uid:", uid)
      console.warn("[Pi Verify] Verified uid:", verifiedUid)
      // This could indicate token reuse or tampering - but we'll use the verified one
    }

    console.log("[Pi Verify] ✓ UID verified successfully")
    console.log("[Pi Verify] Saving verified UID for merchant:", merchantId)

    // Store the verified UID in Redis with a verification cache
    await redis.set(
      `merchant:verified-uid:${merchantId}`,
      JSON.stringify({
        uid: verifiedUid,
        verifiedAt: new Date().toISOString(),
        username: verifiedUser.username,
      }),
      { ex: 3600 } // Cache for 1 hour
    )

    console.log("[Pi Verify] ✅ Verification complete - UID saved")

    return NextResponse.json(
      {
        verified: true,
        uid: verifiedUid,
        username: verifiedUser.username,
        message: "UID verified successfully",
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[Pi Verify] ❌ EXCEPTION:", error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      {
        error: "Verification failed",
        details: error instanceof Error ? error.message : String(error),
        verified: false,
      },
      { status: 500 }
    )
  }
}
