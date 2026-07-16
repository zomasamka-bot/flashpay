import { type NextRequest, NextResponse } from "next/server"

/**
 * DISABLED: /api/reset/payments endpoint
 * 
 * This endpoint has been replaced by the secure emergency endpoint at:
 * /api/emergency/clear-stuck-payment
 * 
 * Use the /emergency page with owner authentication to clear stuck payments.
 */

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// GET /api/reset/payments — Disabled (410 Gone)
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "Gone",
      message: "This endpoint has been disabled. Use /emergency page with owner authentication instead.",
    },
    { status: 410 }
  )
}

// POST /api/reset/payments — Disabled (410 Gone)
export async function POST(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "Gone",
      message: "This endpoint has been disabled. Use /emergency page with owner authentication instead.",
    },
    { status: 410 }
  )
}
