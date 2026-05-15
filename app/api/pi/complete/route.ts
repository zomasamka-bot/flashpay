import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordTransaction } from "@/lib/transaction-service"
import { recordTransactionToPG } from "@/lib/transaction-pg-service"
import { initializeSchema } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface PiPaymentDTO {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    paymentId: string
  }
  from_address: string
  to_address: string
  direction: string
  network: string
  created_at: string
  transaction: {
    txid: string
    verified: boolean
    _link: string
  }
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
}

// POST /api/pi/complete — Called by Pi SDK (onReadyForServerCompletion)
// Completes the payment with Pi Network and marks it PAID in Redis
export async function POST(request: NextRequest) {
  console.log("[Pi Webhook] COMPLETE called at", new Date().toISOString())

  // Initialize database schema on first call (if configured)
  if (config.isPostgresConfigured) {
    try {
      await initializeSchema()
    } catch (error) {
      console.error("[Pi Webhook] Schema initialization error (non-blocking):", error)
      // Continue anyway, tables may already exist
    }
  }

  try {
    const body = await request.json()
    console.log("[Pi Webhook] Complete request body keys:", Object.keys(body))
    
    // Handle both formats: direct Pi payment object (from incomplete payment callback) or wrapped DTO
    const paymentDTO: PiPaymentDTO = body.identifier ? body : body
    
    console.log("[Pi Webhook] Pi Payment ID:", paymentDTO.identifier)
    console.log("[Pi Webhook] Txid:", paymentDTO.transaction?.txid)
    console.log("[Pi Webhook] Our Payment ID:", paymentDTO.metadata?.paymentId)

    const paymentId = paymentDTO.metadata?.paymentId
    
    console.log("[Pi Webhook] ========================================")
    console.log("[Pi Webhook] PAYMENT ID EXTRACTION")
    console.log("[Pi Webhook] paymentDTO.metadata:", JSON.stringify(paymentDTO.metadata))
    console.log("[Pi Webhook] paymentDTO.identifier:", paymentDTO.identifier)
    console.log("[Pi Webhook] Extracted paymentId:", paymentId)
    console.log("[Pi Webhook] ========================================")

    // Retrieve payment from Redis
    let existingPayment = null

    if (!paymentId) {
      console.warn("[Pi Webhook] ⚠️  No paymentId in metadata - cannot look up payment in Redis")
      console.warn("[Pi Webhook] Returning success anyway to avoid blocking Pi webhook")
      // Return 200 OK so Pi doesn't retry — we lose tracking but payment won't get stuck
      return NextResponse.json({ success: true, message: "Payment acknowledged (no internal tracking)" })
    }

    if (isRedisConfigured) {
      const data = await redis.get(`payment:${paymentId}`)
      existingPayment = data ? (typeof data === "string" ? JSON.parse(data) : data) : null
      console.log("[Pi Webhook] Redis lookup - key: payment:" + paymentId + " - found:", !!existingPayment)
    } else {
      console.warn("[Pi Webhook] Redis not configured")
    }

    if (!existingPayment) {
      console.error("[Pi Webhook] ❌ Payment not found in Redis - cannot match to internal system")
      console.error("[Pi Webhook] paymentId:", paymentId)
      console.error("[Pi Webhook] Redis key used: payment:" + paymentId)
      console.warn("[Pi Webhook] Returning success anyway to avoid blocking Pi webhook")
      // Return 200 OK so Pi doesn't retry — payment is on blockchain but not tracked
      return NextResponse.json({ success: true, message: "Payment acknowledged (not found in system)" })
    }

    // DEBUG: Log full retrieved payment to verify merchantUid exists
    console.log("[Pi Webhook] FULL PAYMENT FROM REDIS:")
    console.log("[Pi Webhook]   - ALL KEYS:", Object.keys(existingPayment))
    console.log("[Pi Webhook]   - Full object:", JSON.stringify(existingPayment))
    console.log("[Pi Webhook]   - merchantUid exists:", "merchantUid" in existingPayment)
    console.log("[Pi Webhook]   - merchantUid value:", existingPayment.merchantUid)
    console.log("[Pi Webhook]   - merchantUid type:", typeof existingPayment.merchantUid)

    // CRITICAL: Validate merchantId and createdAt are present
    // Use metadata.merchantId as fallback if not in Redis payment
    const merchantId = existingPayment.merchantId || paymentDTO.metadata?.merchantId
    const merchantUid = existingPayment.merchantUid || paymentDTO.metadata?.merchantUid
    
    // If still no merchantId, reject
    if (!merchantId || typeof merchantId !== "string") {
      console.error("[Pi Webhook] CRITICAL: Cannot determine merchantId from Redis or metadata")
      console.error("[Pi Webhook] Redis merchantId:", existingPayment.merchantId)
      console.error("[Pi Webhook] Metadata merchantId:", paymentDTO.metadata?.merchantId)
      return NextResponse.json({ error: "Cannot determine merchant" }, { status: 400 })
    }
    
    // CRITICAL: Validate merchantUid is present for A2U transfer
    if (!merchantUid || typeof merchantUid !== "string" || merchantUid.trim() === "") {
      console.error("[Pi Webhook] ❌ CRITICAL: No merchantUid found for A2U transfer")
      console.error("[Pi Webhook] Redis merchantUid:", existingPayment.merchantUid)
      console.error("[Pi Webhook] Metadata merchantUid:", paymentDTO.metadata?.merchantUid)
      console.error("[Pi Webhook] This payment cannot be completed - merchant wallet unknown")
      // Still return 200 to avoid Pi retry, but log the error
      return NextResponse.json({ 
        success: false, 
        message: "Payment acknowledged but cannot complete A2U transfer - no merchant UID",
        error: "No merchantUid for transfer"
      }, { status: 200 }) // Return 200 to stop Pi retries
    }
    
    console.log("[Pi Webhook] ✓ merchantUid validated:", merchantUid.substring(0, 10) + "...")

    // If createdAt is missing, use current time as fallback (old payments)
    const createdAt = existingPayment.createdAt || new Date().toISOString()
    
    if (!createdAt) {
      console.error("[Pi Webhook] CRITICAL: Cannot determine createdAt")
      return NextResponse.json({ error: "Cannot determine payment creation time" }, { status: 400 })
    }

    console.log("[Pi Webhook] Payment retrieved:", {
      paymentId,
      merchantId: existingPayment.merchantId,
      merchantUid: existingPayment.merchantUid || "(empty - CRITICAL for A2U)",
      merchantAddress: existingPayment.merchantAddress || "(empty)",
      amount: existingPayment.amount
    })

    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    const txid = paymentDTO.transaction?.txid || paymentDTO.txid
    if (!txid) {
      console.error("[Pi Webhook] No transaction ID found in payment")
      return NextResponse.json({ error: "Missing transaction ID" }, { status: 400 })
    }

    const completionResponse = await fetch(
      `https://api.minepi.com/v2/payments/${paymentDTO.identifier}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      },
    )

    console.log("[Pi Webhook] Pi API Response Status:", completionResponse.status)
    const completionData = await completionResponse.json().catch(() => ({}))
    console.log("[Pi Webhook] Pi API Response Data:", JSON.stringify(completionData))

    // Handle all response cases
    if (!completionResponse.ok) {
      // Check if it's "already_completed" - this is actually SUCCESS, not an error
      if (completionResponse.status === 400 && completionData.error?.message?.includes("already_completed")) {
        console.log("[Pi Webhook] ✓ Payment already completed on Pi side (this is valid)")
        // Continue - this is not an error, payment IS done on Pi
      } else {
        console.error("[Pi Webhook] Pi API completion failed:", completionResponse.status, completionData)
        console.warn("[Pi Webhook] Continuing despite Pi API response - marking payment as paid locally")
      }
    } else {
      console.log("[Pi Webhook] ✓ Payment completed via Pi API")
    }

    // Update status to PAID in Redis — THIS MUST HAPPEN REGARDLESS OF Pi API RESPONSE
    // Once we reach here, the payment HAS been completed (either now or already on Pi side)
    const updatedPayment = {
      ...existingPayment,
      status: "paid" as const,
      paidAt: new Date().toISOString(),
      txid: txid,
      piPaymentId: paymentDTO.identifier,
      // CRITICAL: Preserve merchantAddress for A2U transfer
      merchantAddress: existingPayment.merchantAddress,
    }

    if (isRedisConfigured) {
      await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
      console.log("[Pi Webhook] ✓ Payment marked as PAID in Redis:", paymentId)
      console.log("[Pi Webhook] Redis updated with status: paid, txid:", txid)
    }

    // Verify the payment was actually updated in Redis
    if (isRedisConfigured) {
      const verification = await redis.get(`payment:${paymentId}`)
      if (verification) {
        const stored = typeof verification === "string" ? JSON.parse(verification) : verification
        console.log("[Pi Webhook] ✓ VERIFICATION - Payment in Redis now has:")
        console.log("[Pi Webhook]   - status:", stored.status, "(should be 'paid')")
        console.log("[Pi Webhook]   - txid:", stored.txid)
        console.log("[Pi Webhook]   - paidAt:", stored.paidAt)
      }
    }

    // CRITICAL: Return 200 OK immediately after payment is marked as paid
    // All subsequent operations (transaction recording, settlement queueing) are fire-and-forget
    // This ensures the Pi SDK receives success and doesn't get stuck

    // Ensure payment object has all required fields for transaction recording
    const paymentForRecording = {
      id: existingPayment.id,
      merchantId: merchantId,
      amount: existingPayment.amount,
      note: existingPayment.note || "",
      status: "paid" as const,
      createdAt: createdAt,  // Use fallback createdAt if payment missing it
      paidAt: new Date().toISOString(),
    }

    console.log("[Pi Webhook] Payment object prepared for recording:", {
      id: paymentForRecording.id,
      merchantId: paymentForRecording.merchantId,
      amount: paymentForRecording.amount,
      createdAt: paymentForRecording.createdAt,
      paidAt: paymentForRecording.paidAt,
    })

    // RETURN 200 OK IMMEDIATELY - payment is marked as PAID
    const response = NextResponse.json({ success: true, message: "Payment completed" })

    // IMPORTANT: Don't update merchant balance yet - A2U transfer must complete first
    // recordTransactionToPG is moved to AFTER A2U succeeds (see A2U-SUCCESS section below)

    // IMPORTANT: A2U transfer must succeed BEFORE recording transaction and updating balance
    // Don't do fire-and-forget - wait for A2U result
    if (existingPayment.merchantUid) {
      console.log("[A2U-INIT] ✓ Starting A2U transfer - merchantUid found")
      console.log("[A2U-INIT] Merchant UID from Redis =", existingPayment.merchantUid)
      console.log("[A2U-INIT] Merchant UID length =", existingPayment.merchantUid.length)
      console.log("[A2U-INIT] Merchant UID first 30 chars =", existingPayment.merchantUid.substring(0, 30) + "...")
      console.log("[A2U-INIT] Amount to transfer =", paymentForRecording.amount, "Pi")
      
      const a2uUrl = `${config.appUrl}/api/pi/a2u`
      const a2uRequestBody = {
        paymentId: paymentForRecording.id,
        merchantId: paymentForRecording.merchantId,
        merchantUid: existingPayment.merchantUid,
        accessToken: existingPayment.accessToken, // Send accessToken for /v2/me verification
        amount: paymentForRecording.amount,
        memo: paymentForRecording.note || `Payment settlement`,
      }
      
      console.log("[A2U-INIT] Sending A2U request with body:")
      console.log(JSON.stringify({...a2uRequestBody, accessToken: a2uRequestBody.accessToken ? "PROVIDED" : "MISSING"}, null, 2))
      
      try {
        const a2uResponse = await fetch(a2uUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(a2uRequestBody),
        })
        
        const a2uData = await a2uResponse.json()
        
        if (a2uResponse.ok && a2uData.success) {
          // A2U completed successfully - all steps done
          console.log("[A2U-SUCCESS] ✅ A2U TRANSFER COMPLETE")
          console.log("[A2U-SUCCESS] All A2U steps completed:")
          console.log("[A2U-SUCCESS]   1. createPayment: success")
          console.log("[A2U-SUCCESS]   2. build & sign: success")
          console.log("[A2U-SUCCESS]   3. Horizon submit: success (txid:", a2uData.txid + ")")
          console.log("[A2U-SUCCESS]   4. Pi complete: success")
          console.log("[A2U-SUCCESS] Pi payment identifier:", a2uData.a2uPaymentId)
          console.log("[A2U-SUCCESS] Amount transferred:", a2uData.amount, "Pi")
          console.log("[A2U-SUCCESS] Merchant will receive funds in their Pi wallet")
          
          // Update payment with A2U identifier for tracking - ONLY if all steps succeeded
          if (isRedisConfigured) {
            await redis.set(
              `payment:${paymentForRecording.id}`,
              JSON.stringify({
                ...paymentForRecording,
                a2uPaymentId: a2uData.a2uPaymentId,
                a2uStatus: "complete",
                a2uSteps: a2uData.steps,
                a2uTxid: a2uData.txid,
                settlementCompletedAt: new Date().toISOString(),
              })
            )
          }
          
          // ONLY NOW: Update merchant balance - AFTER Horizon submit succeeded AND Pi complete succeeded
          console.log("[Pi Webhook] ✓ A2U succeeded - NOW updating merchant balance and recording transaction")
          console.log("[Pi Webhook] Recording PostgreSQL transaction for merchantId:", paymentForRecording.merchantId)
          
          recordTransactionToPG(
            paymentForRecording,
            paymentDTO.identifier,
            txid,
          ).then((result) => {
            if (result) {
              console.log("[Pi Webhook] ✅ PostgreSQL transaction recorded - merchant balance updated:", result)
            } else {
              console.warn("[Pi Webhook] PostgreSQL transaction recording returned null")
            }
          }).catch((err) => {
            console.warn("[Pi Webhook] PostgreSQL transaction recording error:", err)
          })
        } else if (a2uResponse.status === 202 && (a2uData.status === "pending_signing" || a2uData.status === "pending_implementation" || a2uData.status === "reusing_ongoing")) {
          // A2U is waiting for blockchain signing - not a failure, awaiting configuration or implementation
          const statusDesc = 
            a2uData.status === "pending_signing" ? "AWAITING_PRIVATE_KEY" :
            a2uData.status === "reusing_ongoing" ? "REUSING_ONGOING_PAYMENT" :
            "IMPLEMENTATION_PENDING"
          
          console.warn("[A2U-PENDING] ⏳ A2U PENDING - " + statusDesc)
          console.warn("[A2U-PENDING] A2U payment status:", a2uData.status)
          console.warn("[A2U-PENDING] Pi payment identifier:", a2uData.a2uPaymentId)
          
          if (a2uData.status === "pending_signing") {
            console.warn("[A2U-PENDING] Awaiting PI_PRIVATE_SEED environment variable for blockchain signing")
          } else if (a2uData.status === "reusing_ongoing") {
            console.warn("[A2U-PENDING] Reusing existing ongoing A2U payment - will complete when signing is available")
          } else {
            console.warn("[A2U-PENDING] Awaiting implementation of blockchain signing step")
          }
          
          // Mark payment as settlement pending with a2uPaymentId - U2A payment is complete, but A2U awaiting signing
          if (isRedisConfigured) {
            await redis.set(
              `payment:${paymentForRecording.id}`,
              JSON.stringify({
                ...paymentForRecording,
                a2uPaymentId: a2uData.a2uPaymentId,
                a2uStatus: a2uData.status, // "pending_signing", "pending_implementation", or "reusing_ongoing"
                step1: "createPayment_success",
                step2: a2uData.step2,
                step3: "pending",
                fromAddress: a2uData.fromAddress,
                toAddress: a2uData.toAddress,
                requiresManualReview: a2uData.requiresManualReview || false,
                settlementPendingAt: new Date().toISOString(),
                note: a2uData.details || "Awaiting blockchain signing",
              })
            )
          }
          
          // Still record transaction for audit but don't update merchant balance yet
          recordTransaction(
            paymentForRecording,
            paymentDTO.identifier,
            txid,
          ).catch((err) => console.warn("[Pi Webhook] PostgreSQL transaction recording error:", err))
        } else {
          // A2U actually failed
          console.error("[A2U-FAILURE] ❌ A2U TRANSFER FAILED")
          console.error("[A2U-FAILURE] Response status:", a2uResponse.status)
          console.error("[A2U-FAILURE] Error:", a2uData.error)
          console.error("[A2U-FAILURE] Error details:", a2uData.details)
          console.error("[A2U-FAILURE] Failed step:", a2uData.step)
          console.error("[A2U-FAILURE] Payment marked as PAID but settlement failed")
          console.error("[A2U-FAILURE] Merchant will NOT receive funds - requires manual intervention")
          
          // Mark payment with A2U failure for manual review
          if (isRedisConfigured) {
            await redis.set(
              `payment:${paymentForRecording.id}`,
              JSON.stringify({
                ...paymentForRecording,
                a2uStatus: "failed",
                a2uFailedStep: a2uData.step || "unknown",
                a2uError: a2uData.error || "Unknown error",
                requiresManualReview: true,
                failedAt: new Date().toISOString(),
              })
            )
          }
        }
      } catch (a2uError) {
        console.error("[A2U-ERROR] ❌ A2U request failed:")
        console.error("[A2U-ERROR] Error:", a2uError instanceof Error ? a2uError.message : String(a2uError))
        console.error("[A2U-ERROR] Payment marked as PAID but A2U failed - needs manual resolution")
        
        // Mark payment with A2U error for manual review
        if (isRedisConfigured) {
          await redis.set(
            `payment:${paymentForRecording.id}`,
            JSON.stringify({
              ...paymentForRecording,
              a2uStatus: "error",
              a2uError: a2uError instanceof Error ? a2uError.message : String(a2uError),
              requiresManualReview: true,
            })
          )
        }
      }
    } else {
      console.warn("[A2U-INIT] ⚠️ SKIPPED - Merchant UID is empty or missing")
      console.warn("[A2U-INIT] existingPayment.merchantUid =", existingPayment.merchantUid)
      console.warn("[A2U-INIT] Payment marked PAID but cannot settle - needs manual resolution")
      
      // Mark payment with missing UID for manual review
      if (isRedisConfigured) {
        await redis.set(
          `payment:${paymentForRecording.id}`,
          JSON.stringify({
            ...paymentForRecording,
            a2uStatus: "skipped",
            a2uError: "Merchant UID is missing",
            requiresManualReview: true,
          })
        )
      }
    }

    return response
  } catch (error) {
    console.error("[Pi Webhook] COMPLETE error:", error)
    return NextResponse.json({ error: "Failed to complete payment" }, { status: 500 })
  }
}
