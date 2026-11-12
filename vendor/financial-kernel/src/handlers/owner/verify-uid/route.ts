import { NextRequest, NextResponse } from "next/server"
import { StrKey } from "@stellar/stellar-sdk"
import { publicConfig } from "../../../lib/config"

export async function POST(request: NextRequest) {
  const input = await request.json().catch(() => null)
  if (!input || typeof input.uid !== "string" || !input.uid ||
      typeof input.accessToken !== "string" || !input.accessToken)
    return NextResponse.json({ success: false, error: "Invalid identity" }, { status: 400 })

  if (!publicConfig.isOwnerConfigured || !publicConfig.ownerUid)
    return NextResponse.json({ success: false, error: "Owner verification not configured" }, { status: 500 })

  try {
    const response = await fetch("https://api.minepi.com/v2/me", {
      method: "GET", headers: { Authorization: `Bearer ${input.accessToken}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000),
    })
    if (response.status === 401 || response.status === 403)
      return NextResponse.json({ success: false, error: "Invalid access token" }, { status: 403 })
    if (!response.ok) throw new Error("Provider unavailable")
    const user = await response.json()
    if (!user || user.uid !== input.uid || user.uid !== publicConfig.ownerUid)
      return NextResponse.json({ success: false, error: "Not authorized as owner" }, { status: 403 })

    const scoped = Array.isArray(user.credentials?.scopes) && user.credentials.scopes.includes("wallet_address")
    const provided = user.wallet_address
    const fromSdk = input.sdkWalletAddress
    // SDK fields are display-only. Never use them as a transfer destination or
    // as proof of wallet custody. Older callers may verify UID without a wallet.
    if (scoped && ((provided != null && !StrKey.isValidEd25519PublicKey(provided)) ||
        (fromSdk != null && !StrKey.isValidEd25519PublicKey(fromSdk)) ||
        (provided && fromSdk && provided !== fromSdk)))
      return NextResponse.json({ success: false, error: "Wallet evidence conflicts" }, { status: 409 })
    return NextResponse.json({
      success: true, isOwner: true, timestamp: new Date().toISOString(),
      walletAddress: scoped ? provided ?? null : null,
      sdkDisplayAddress: scoped && !provided ? fromSdk ?? null : null,
    }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ success: false, error: "Pi identity service unavailable" }, { status: 503 })
  }
}
