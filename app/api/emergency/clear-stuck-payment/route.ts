import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// Verify Bearer token and owner authorization
async function verifyOwnerAuth(token: string, ownerUid?: string) {
  try {
    // Check if owner UID is configured
    if (!ownerUid) {
      console.log("[Emergency-Auth] Owner UID not configured")
      return { verified: null, statusCode: 500 }
    }
    
    // Verify token with Pi /v2/me endpoint
    const meResponse = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${token}` },
    })
    
    if (!meResponse.ok) {
      console.log("[Emergency-Auth] Token verification failed:", meResponse.status)
      return { verified: null, statusCode: 401 }
    }
    
    const meData = await meResponse.json()
    const verifiedUid = meData.uid
    
    console.log("[Emergency-Auth] Token verified for uid:", verifiedUid)
    
    // Compare with owner UID
    if (verifiedUid !== ownerUid) {
      console.log("[Emergency-Auth] UID mismatch - not owner. Expected:", ownerUid, "Got:", verifiedUid)
      return { verified: null, statusCode: 403 }
    }
    
    return { verified: verifiedUid, statusCode: 200 }
  } catch (error) {
    console.error("[Emergency-Auth] Token verification error:", error)
    return { verified: null, statusCode: 401 }
  }
}

// GET /api/emergency/clear-stuck-payment — List all pending payments (owner only)
export async function GET(request: NextRequest) {
  console.log("[Emergency] GET - Listing stuck payments")
  
  // Get config for owner UID
  const config = require("@/lib/config").config || {}
  
  // Verify authorization
  const authHeader = request.headers.get("authorization")
  const token = authHeader?.replace("Bearer ", "") || ""
  
  if (!token) {
    console.log("[Emergency] No authorization header")
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 })
  }
  
  const authResult = await verifyOwnerAuth(token, config.ownerUid)
  if (authResult.statusCode === 500) {
    return NextResponse.json({ error: "Owner UID not configured" }, { status: 500 })
  }
  if (!authResult.verified) {
    console.log("[Emergency] Authorization failed with status:", authResult.statusCode)
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.statusCode })
  }
  
  if (!isRedisConfigured) {
    return NextResponse.json(
      { error: "Redis not configured", stuckPayments: [] },
      { status: 503 }
    )
  }

  try {
    // Get all payment keys from Redis
    const allKeys = await redis.keys("payment:*")
    console.log("[Emergency] Found payment keys:", allKeys.length)
    
    const stuckPayments: any[] = []
    
    for (const key of allKeys) {
      const paymentData = await redis.get(key)
      if (paymentData) {
        const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
        if (String(payment.status).toLowerCase() === "pending") {
          stuckPayments.push({
            id: payment.id,
            amount: payment.amount,
            status: payment.status,
            createdAt: payment.createdAt,
            note: payment.note,
          })
        }
      }
    }
    
    console.log("[Emergency] Stuck pending payments:", stuckPayments.length)
    
    return NextResponse.json({
      success: true,
      stuckPaymentCount: stuckPayments.length,
      stuckPayments,
      message: stuckPayments.length > 0 
        ? `Found ${stuckPayments.length} stuck payment(s) - POST to clear` 
        : "No stuck payments found"
    })
  } catch (error) {
    console.error("[Emergency] Error listing payments:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

// POST /api/emergency/clear-stuck-payment — Clear a single stuck payment (owner only)
export async function POST(request: NextRequest) {
  console.log("[Emergency] POST - Clearing single payment")
  
  // Get config for owner UID
  const config = require("@/lib/config").config || {}
  
  // Verify authorization
  const authHeader = request.headers.get("authorization")
  const token = authHeader?.replace("Bearer ", "") || ""
  
  if (!token) {
    console.log("[Emergency-POST] No authorization header")
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 })
  }
  
  const authResult = await verifyOwnerAuth(token, config.ownerUid)
  if (authResult.statusCode === 500) {
    return NextResponse.json({ error: "Owner UID not configured" }, { status: 500 })
  }
  if (!authResult.verified) {
    console.log("[Emergency-POST] Authorization failed with status:", authResult.statusCode)
    return NextResponse.json({ error: "Unauthorized" }, { status: authResult.statusCode })
  }
  
  if (!isRedisConfigured) {
    return NextResponse.json(
      { error: "Redis not configured" },
      { status: 503 }
    )
  }

  try {
    // Get paymentId from request body
    const body = await request.json()
    const { paymentId } = body
    
    if (!paymentId) {
      console.log("[Emergency-POST] Missing paymentId")
      return NextResponse.json({ error: "Missing paymentId in request body" }, { status: 400 })
    }
    
    // Only read this specific payment
    const key = `payment:${paymentId}`
    const paymentData = await redis.get(key)
    
    if (!paymentData) {
      console.log("[Emergency-POST] Payment not found:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }
    
    const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
    console.log("[Emergency-POST] Current payment status:", payment.status)
    
    // Only cancel if status is pending (case-insensitive, safe check)
    if (String(payment.status).toLowerCase() !== "pending") {
      console.log("[Emergency-POST] Payment status is not pending:", payment.status)
      return NextResponse.json(
        { error: `Cannot clear payment with status: ${payment.status}. Only pending payments can be cleared.` },
        { status: 409 }
      )
    }
    
    // Mark as cancelled, preserving all existing fields
    const clearedPayment = {
      ...payment,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelReason: "Emergency clear - owner action",
    }
    
    await redis.set(key, JSON.stringify(clearedPayment))
    console.log("[Emergency-POST] Successfully cleared payment:", paymentId)
    
    // Return public payment fields only (no sensitive data)
    return NextResponse.json({
      success: true,
      message: `Cleared payment ${paymentId}. System is now ready for new payments.`,
      payment: {
        id: clearedPayment.id,
        merchantId: clearedPayment.merchantId,
        amount: clearedPayment.amount,
        note: clearedPayment.note,
        status: clearedPayment.status,
        createdAt: clearedPayment.createdAt,
        cancelledAt: clearedPayment.cancelledAt,
      }
    })
  } catch (error) {
    console.error("[Emergency-POST] Error clearing payment:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
