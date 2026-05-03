import { type NextRequest, NextResponse } from "next/server"
import { config } from "@/lib/config"
import { redis, isRedisConfigured } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface A2UPaymentRequest {
  paymentId: string
  merchantId: string
  merchantUid: string
  amount: number
  memo: string
}

// POST /api/pi/a2u — App-to-User payment (transfer funds from app wallet to merchant wallet)
// Called after U2A payment is completed
export async function POST(request: NextRequest) {
  console.log("[Pi A2U] App-to-User payment initiated at", new Date().toISOString())

  try {
    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi A2U] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    const body: A2UPaymentRequest = await request.json()
    const { paymentId, merchantId, merchantUid, amount, memo } = body

    // VERIFICATION: Calculate uid signature to track exact value
    const receivedUidHash = merchantUid ? merchantUid.charAt(0) + merchantUid.charAt(merchantUid.length - 1) + merchantUid.length : "EMPTY"
    
    console.log("[Pi A2U] === UID VERIFICATION AT ENDPOINT ===")
    console.log("[Pi A2U] Full request body received:", JSON.stringify(body, null, 2))
    console.log("[Pi A2U]")
    console.log("[Pi A2U] Extracted merchantUid:", merchantUid)
    console.log("[Pi A2U] merchantUid signature:", receivedUidHash)
    console.log("[Pi A2U] merchantUid type:", typeof merchantUid)
    console.log("[Pi A2U] merchantUid length:", merchantUid?.length || 0)
    console.log("[Pi A2U] merchantUid empty:", !merchantUid || merchantUid.trim() === "")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] Payment context:")
    console.log("[Pi A2U]   paymentId:", paymentId)
    console.log("[Pi A2U]   merchantId:", merchantId)
    console.log("[Pi A2U]   amount:", amount)
    console.log("[Pi A2U] ======================================")

    // Validate required fields
    if (!merchantUid || merchantUid.trim() === "") {
      console.error("[Pi A2U] ❌ CRITICAL: Merchant UID is empty - cannot send funds")
      console.error("[Pi A2U] Request was:", JSON.stringify(body))
      return NextResponse.json(
        { error: "Merchant UID is required for fund transfer", success: false },
        { status: 400 }
      )
    }

    // Additional validation: UID should be a valid string without excessive whitespace
    const trimmedUid = merchantUid.trim()
    if (trimmedUid.length < 5 || trimmedUid.length > 100) {
      console.error("[Pi A2U] ❌ INVALID UID FORMAT")
      console.error("[Pi A2U] UID:", merchantUid)
      console.error("[Pi A2U] UID length:", merchantUid.length)
      console.error("[Pi A2U] UID length after trim:", trimmedUid.length)
      return NextResponse.json(
        { error: "Invalid merchant UID format - length out of range", success: false },
        { status: 400 }
      )
    }

    if (!merchantId) {
      console.error("[Pi A2U] Merchant ID is missing")
      return NextResponse.json(
        { error: "Merchant ID is required" },
        { status: 400 }
      )
    }

    if (amount <= 0) {
      console.error("[Pi A2U] Invalid amount:", amount)
      return NextResponse.json(
        { error: "Amount must be greater than 0" },
        { status: 400 }
      )
    }

    // Create App-to-User payment via Pi API
    console.log("[Pi A2U] Creating A2U payment with Pi API")
    console.log("[Pi A2U] Sending", amount, "Pi to user UID:", merchantUid)

    const requestBody = {
      amount: amount,
      memo: memo || `FlashPay settlement for ${paymentId}`,
      metadata: {
        paymentId,
        merchantId,
        type: "a2u_settlement",
        timestamp: new Date().toISOString(),
      },
      recipient: {
        recipient_uid: merchantUid,
      },
    }

    // VERIFICATION: Calculate signature of uid being sent to Pi API
    const sentUidHash = merchantUid.charAt(0) + merchantUid.charAt(merchantUid.length - 1) + merchantUid.length
    
    console.log("[Pi A2U] === EXACT UID BEING SENT TO Pi API ===")
    console.log("[Pi A2U] Full request body:")
    console.log(JSON.stringify(requestBody, null, 2))
    console.log("[Pi A2U]")
    console.log("[Pi A2U] EXACT recipient_uid value:", requestBody.recipient.recipient_uid)
    console.log("[Pi A2U] EXACT recipient_uid signature:", sentUidHash)
    console.log("[Pi A2U] EXACT recipient_uid type:", typeof requestBody.recipient.recipient_uid)
    console.log("[Pi A2U] EXACT recipient_uid length:", requestBody.recipient.recipient_uid.length)
    console.log("[Pi A2U]")
    console.log("[Pi A2U] UID signature matches received:", sentUidHash === receivedUidHash)
    console.log("[Pi A2U] Amount:", requestBody.amount, "Pi")
    console.log("[Pi A2U] Memo:", requestBody.memo)
    console.log("[Pi A2U] =========================================")

    const a2uResponse = await fetch("https://api.minepi.com/v2/payments", {
      method: "POST",
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    console.log("[Pi A2U] Pi API Response Status:", a2uResponse.status)
    console.log("[Pi A2U] Pi API Response Headers:", Object.fromEntries(a2uResponse.headers.entries()))

    if (!a2uResponse.ok) {
      const errorData = await a2uResponse.text()
      console.error("[Pi A2U] ❌ A2U API CALL FAILED")
      console.error("[Pi A2U] Status:", a2uResponse.status)
      console.error("[Pi A2U] Status Text:", a2uResponse.statusText)
      console.error("[Pi A2U] Error Response Body:", errorData)
      console.error("[Pi A2U] Request that failed:")
      console.error("[Pi A2U]   - amount:", amount)
      console.error("[Pi A2U]   - recipient_uid:", merchantUid)
      console.error("[Pi A2U]   - paymentId:", paymentId)
      
      return NextResponse.json(
        {
          error: "Failed to initiate fund transfer to merchant",
          details: errorData,
          piStatus: a2uResponse.status,
          success: false,
        },
        { status: a2uResponse.status }
      )
    }

    const a2uPayment = await a2uResponse.json()
    console.log("[Pi A2U] ✓ SUCCESS: A2U payment accepted by Pi API")
    console.log("[Pi A2U] === FULL Pi API RESPONSE ===")
    console.log("[Pi A2U]", JSON.stringify(a2uPayment, null, 2))
    console.log("[Pi A2U] =============================")
    console.log("[Pi A2U] Pi Payment ID:", a2uPayment.identifier)
    console.log("[Pi A2U] Status:", a2uPayment.status)
    console.log("[Pi A2U] Amount transferred:", amount, "Pi")
    console.log("[Pi A2U] Recipient UID:", merchantUid)

    // Store A2U payment reference in Redis for tracking
    if (isRedisConfigured) {
      try {
        const a2uKey = `a2u:${paymentId}`
        await redis.set(
          a2uKey,
          JSON.stringify({
            originalPaymentId: paymentId,
            piPaymentId: a2uPayment.identifier,
            merchantId,
            merchantUid,
            amount,
            status: "initiated",
            createdAt: new Date().toISOString(),
          })
        )
        console.log("[Pi A2U] A2U payment reference stored in Redis")
      } catch (error) {
        console.warn("[Pi A2U] Failed to store A2U reference (non-blocking):", error)
      }
    }

    return NextResponse.json({
      success: true,
      message: "Fund transfer to merchant initiated successfully",
      a2uPaymentId: a2uPayment.identifier,
      a2uStatus: a2uPayment.status,
      amount,
      merchantUid: merchantUid.substring(0, 10) + "...",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[Pi A2U] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to process fund transfer",
        details: error instanceof Error ? error.message : String(error),
        success: false,
      },
      { status: 500 }
    )
  }
}
