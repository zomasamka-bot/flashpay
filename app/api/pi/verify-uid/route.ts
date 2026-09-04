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
    const body = (await request.json()) as VerifyUidRequest
    const { uid, accessToken, merchantId } = body

    if (typeof uid !== "string" || typeof accessToken !== "string" || typeof merchantId !== "string" || uid.trim().length === 0 || accessToken.trim().length === 0 || merchantId.trim().length === 0) {
      return NextResponse.json(
        { error: "Missing uid, accessToken, or merchantId", verified: false },
        { status: 400 }
      )
    }

    const normalizedUid = uid.trim()
    const normalizedAccessToken = accessToken.trim()
    const normalizedMerchantId = merchantId.trim()

    const verifyResponse = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${normalizedAccessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!verifyResponse.ok) {
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
    const verifiedUid = typeof verifiedUser.uid === "string" ? verifiedUser.uid.trim() : ""
    const verifiedUsername = typeof verifiedUser.username === "string" ? verifiedUser.username.trim() : ""

    if (verifiedUid.length === 0 || verifiedUsername.length === 0 || verifiedUid !== normalizedUid || verifiedUsername !== normalizedMerchantId) {
      return NextResponse.json({ error: "Pi identity mismatch", verified: false }, { status: 409 })
    }

    await redis.set(
      `merchant:verified-uid:${verifiedUsername}`,
      JSON.stringify({
        uid: verifiedUid,
        verifiedAt: new Date().toISOString(),
        username: verifiedUsername,
      }),
      { ex: 3600 }
    )

    return NextResponse.json(
      {
        verified: true,
        uid: verifiedUid,
        username: verifiedUsername,
        message: "UID verified successfully",
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[Pi Verify] ❌ EXCEPTION:", error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      {
        error: "Verification failed",
        verified: false,
      },
      { status: 500 }
    )
  }
}
