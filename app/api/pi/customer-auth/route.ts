import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { accessToken?: unknown }
    if (typeof body.accessToken !== "string" || body.accessToken.trim() === "") {
      return NextResponse.json({ verified: false }, { status: 401 })
    }

    const response = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${body.accessToken}` },
      cache: "no-store",
    })
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json({ verified: false }, { status: 401 })
    }
    if (!response.ok) return NextResponse.json({ verified: false }, { status: 503 })

    const credentials = await response.json()
    const scopes = credentials?.scopes
    if (
      typeof credentials?.uid !== "string" ||
      credentials.uid.trim() === "" ||
      !Array.isArray(scopes) ||
      !scopes.includes("payments") ||
      !scopes.includes("wallet_address")
    ) return NextResponse.json({ verified: false }, { status: 401 })

    return NextResponse.json({ verified: true }, { status: 200 })
  } catch {
    return NextResponse.json({ verified: false }, { status: 503 })
  }
}
