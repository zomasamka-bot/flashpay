import { NextResponse } from "next/server"

// Test endpoint to verify Pi webhooks can reach your server
export async function GET() {
  return NextResponse.json({
    success: true,
    message: "Pi webhook endpoint is accessible",
    timestamp: new Date().toISOString(),
    environment: {
      APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      VERCEL_REGION: process.env.VERCEL_REGION,
    }
  })
}

export async function POST() {
  return NextResponse.json({
    success: true,
    message: "Pi webhook POST is working",
    timestamp: new Date().toISOString(),
  })
}
