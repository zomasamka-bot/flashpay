import { NextResponse } from "next/server"

export async function GET() {
  // Pi Network metadata endpoint
  // Required by Pi Browser/PiNet infrastructure
  return NextResponse.json({
    app_id: "flashpay0734",
    name: "FlashPay",
    description: "Create Pi payment requests in seconds",
    version: "1.0.0",
    status: "active"
  }, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache"
    }
  })
}
