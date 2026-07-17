import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { config } from "@/lib/config"
import { recordTransaction } from "@/lib/transaction-service"
import { recordA2UTransactionAtomic } from "@/lib/db"

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

  try {
    const body = await request.json()
    const identifier = body.identifier
    const clientTxid = body.transaction?.txid || body.txid

    // Require identifier and txid
    if (!identifier) {
      console.error("[Pi Webhook] Missing identifier in request")
      return NextResponse.json({ error: "Missing identifier" }, { status: 400 })
    }
    if (!clientTxid) {
      console.error("[Pi Webhook] Missing txid in request")
      return NextResponse.json({ error: "Missing txid" }, { status: 400 })
    }

    console.log("[Pi Webhook] Identifier:", identifier)
    console.log("[Pi Webhook] Client Txid:", clientTxid)

    // Fetch canonical Pi payment using server API key
    if (!config.isPiApiKeyConfigured) {
      console.error("[Pi Webhook] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    console.log("[Pi Webhook] Fetching canonical Pi payment from Pi API...")
    const piPaymentResponse = await fetch(`https://api.minepi.com/v2/payments/${identifier}`, {
      method: "GET",
      headers: {
        Authorization: `Key ${config.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!piPaymentResponse.ok) {
      console.error("[Pi Webhook] Failed to fetch Pi payment:", piPaymentResponse.status)
      return NextResponse.json({ error: "Failed to fetch Pi payment" }, { status: 400 })
    }

    const piPayment = await piPaymentResponse.json()
    console.log("[Pi Webhook] Pi payment fetched - metadata:", piPayment.metadata)

    // Use ONLY metadata.paymentId to load Redis
    const paymentId = piPayment.metadata?.paymentId
    if (!paymentId) {
      console.error("[Pi Webhook] No paymentId in Pi payment metadata")
      return NextResponse.json({ error: "Invalid Pi payment metadata" }, { status: 400 })
    }

    const paymentDTO: PiPaymentDTO = piPayment
    
    // Retrieve payment from Redis
    if (!isRedisConfigured) {
      console.error("[Pi Webhook] Redis not configured")
      return NextResponse.json({ error: "Redis not configured" }, { status: 500 })
    }

    const data = await redis.get(`payment:${paymentId}`)
    const existingPayment = data ? (typeof data === "string" ? JSON.parse(data) : data) : null

    if (!existingPayment) {
      console.error("[Pi Webhook] Payment not found in Redis:", paymentId)
      return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    }

    console.log("[Pi Webhook] Payment retrieved from Redis:", paymentId)

    // VERIFICATION CHECKS - validate Pi payment against Redis and Pi status
    const piStatus = paymentDTO.status
    const piTransaction = paymentDTO.transaction

    // Check: user_to_app
    if (paymentDTO.direction !== "user_to_app") {
      console.error("[Pi Webhook] Invalid direction:", paymentDTO.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    // Check: approved
    if (!piStatus.developer_approved) {
      console.error("[Pi Webhook] Payment not approved by developer")
      return NextResponse.json({ error: "Payment not approved" }, { status: 400 })
    }

    // Check: not cancelled
    if (piStatus.cancelled || piStatus.user_cancelled) {
      console.error("[Pi Webhook] Payment is cancelled")
      return NextResponse.json({ error: "Payment is cancelled" }, { status: 400 })
    }

    // Check: transaction verified
    if (!piTransaction.verified) {
      console.error("[Pi Webhook] Transaction not verified")
      return NextResponse.json({ error: "Transaction not verified" }, { status: 400 })
    }

    // Check: matching txid
    if (piTransaction.txid !== clientTxid) {
      console.error("[Pi Webhook] Txid mismatch - Pi:", piTransaction.txid, "Client:", clientTxid)
      return NextResponse.json({ error: "Txid mismatch" }, { status: 400 })
    }

    // Check: matching amount (trust Redis amount)
    if (paymentDTO.amount !== existingPayment.amount) {
      console.error("[Pi Webhook] Amount mismatch - Pi:", paymentDTO.amount, "Redis:", existingPayment.amount)
      return NextResponse.json({ error: "Amount mismatch" }, { status: 400 })
    }

    // Extract and verify merchant data BEFORE paid/reconciliation check (needed for all paths)
    const merchantId = existingPayment.merchantId
    const merchantUid = existingPayment.merchantUid
    const createdAt = existingPayment.createdAt || new Date().toISOString()
    
    // Validate Date for DB helper (keeps Redis/in-memory as ISO strings)
    const parsedCreatedAt = new Date(createdAt)
    const createdAtDate = Number.isNaN(parsedCreatedAt.getTime()) ? new Date() : parsedCreatedAt

    if (!merchantId || typeof merchantId !== "string") {
      console.error("[Pi Webhook] No merchantId in Redis")
      return NextResponse.json({ error: "Invalid payment record" }, { status: 400 })
    }

    if (!merchantUid || typeof merchantUid !== "string") {
      console.error("[Pi Webhook] No merchantUid in Redis for A2U")
      return NextResponse.json({ error: "Cannot perform A2U transfer" }, { status: 400 })
    }

    // Store verified Pi payment identifiers BEFORE any branching
    const u2aIdentifier = identifier
    const u2aTxid = clientTxid

    // Check: Redis status is pending or handle already-paid/settling cases
    if (existingPayment.status === "paid_to_app" || existingPayment.status === "settlement_pending" || existingPayment.status === "settled_to_merchant" || existingPayment.status === "settlement_failed") {
      // Already marked as paid/settling/settled - require both same piPaymentId AND txid
      if (existingPayment.piPaymentId === identifier && existingPayment.txid === clientTxid) {
        // Check if this is a DB reconciliation retry
        if (existingPayment.requiresDbReconciliation) {
          console.log("[Pi Webhook] Payment already paid - DB reconciliation required, retrying DB write only (NO A2U repeat)")
          
          // Perform DB reconciliation using only stored verified data, never repeat A2U
          const dbResult = await recordA2UTransactionAtomic({
            u2aIdentifier: u2aIdentifier,                   // Use verified U2A identifier from line 172
            u2aTxid: u2aTxid,                               // Use verified U2A txid from line 173
            a2uIdentifier: existingPayment.a2uIdentifier,  // Use stored A2U identifier
            a2uTxid: existingPayment.a2uTxid,              // Use stored A2U txid (NO new A2U request)
            merchantId: merchantId,
            merchantUid: merchantUid,
            amount: existingPayment.amount,
            note: existingPayment.note || "A2U Settlement",
            createdAt: createdAtDate,
          })
          
          if (dbResult.success) {
            console.log("[Pi Webhook] ✅ Atomic transaction committed successfully")
            console.log("[Pi Webhook] - Transaction ID:", dbResult.transactionId)
            console.log("[Pi Webhook] - U2A identifier:", paymentForRecording.id)
            console.log("[Pi Webhook] - A2U identifier:", paymentDTO.identifier)
            console.log("[Pi Webhook] - A2U txid:", a2uData.txid)
            console.log("[Pi Webhook] - Merchant balance updated: +", paymentForRecording.amount, "π")
            
            // CRITICAL: Only now mark as settled_to_merchant - DB commit succeeded
            if (isRedisConfigured) {
              await redis.set(
                `payment:${paymentId}`,
                JSON.stringify({
                  ...updatedPayment,
                  status: "settled_to_merchant" as const,
                  a2uPaymentId: a2uData.a2uPaymentId,
                  a2uTxid: a2uData.txid,
                  a2uFromAddress: a2uData.fromAddress,
                  a2uToAddress: a2uData.toAddress,
                  a2uStatus: "complete",
                  settledAt: new Date().toISOString(),
                })
              )
              console.log("[Pi Webhook] ✓ Payment marked as SETTLED_TO_MERCHANT after DB commit")
            }
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
          
          // Mark payment as settlement pending with a2uPaymentId - U2A complete, A2U awaiting signing
          if (isRedisConfigured) {
            await redis.set(
              `payment:${paymentId}`,
              JSON.stringify({
                ...updatedPayment,
                status: "settlement_pending" as const,
                a2uPaymentId: a2uData.a2uPaymentId,
                a2uStatus: a2uData.status, // "pending_signing", "pending_implementation", or "reusing_ongoing"
                a2uFromAddress: a2uData.fromAddress,
                a2uToAddress: a2uData.toAddress,
                requiresManualReview: a2uData.requiresManualReview || false,
                note: a2uData.details || "Awaiting blockchain signing",
              })
            )
          }
          
          // For pending A2U (awaiting signing), still record transaction for audit trail but balance won't be settled yet
          // The atomic transaction will only update balance when A2U actually completes
          console.log("[Pi Webhook] A2U pending - recording audit transaction (balance not settled yet)")
        } else {
          // A2U actually failed - mark as settlement_failed
          console.error("[A2U-FAILURE] ❌ A2U TRANSFER FAILED")
          console.error("[A2U-FAILURE] Response status:", a2uResponse.status)
          console.error("[A2U-FAILURE] Error:", a2uData.error)
          console.error("[A2U-FAILURE] Error details:", a2uData.details)
          console.error("[A2U-FAILURE] Failed step:", a2uData.step)
          console.error("[A2U-FAILURE] Payment marked as PAID_TO_APP but settlement FAILED")
          console.error("[A2U-FAILURE] Merchant will NOT receive funds - requires manual intervention or retry")
          
          // Mark payment as settlement_failed - U2A succeeded but A2U failed
          // Store all A2U identifiers if they were created before failure
          if (isRedisConfigured) {
            await redis.set(
              `payment:${paymentId}`,
              JSON.stringify({
                ...updatedPayment,
                status: "settlement_failed" as const,
                a2uPaymentId: a2uData.a2uPaymentId || undefined, // May be set if createPayment succeeded
                a2uStatus: "failed",
                a2uFailedStep: a2uData.step || "unknown",
                a2uError: a2uData.error || "Unknown error",
                a2uFromAddress: a2uData.fromAddress,
                a2uToAddress: a2uData.toAddress,
                requiresManualReview: true,
                failedAt: new Date().toISOString(),
              })
            )
          }
        }
      } catch (a2uError) {
        console.error("[A2U-ERROR] ❌ A2U request failed:")
        console.error("[A2U-ERROR] Error:", a2uError instanceof Error ? a2uError.message : String(a2uError))
        console.error("[A2U-ERROR] Payment marked as PAID_TO_APP but A2U failed - needs manual resolution")
        
        // Mark payment as settlement_failed on unexpected error
        if (isRedisConfigured) {
          await redis.set(
            `payment:${paymentId}`,
            JSON.stringify({
              ...updatedPayment,
              status: "settlement_failed" as const,
              a2uStatus: "error",
              a2uError: a2uError instanceof Error ? a2uError.message : String(a2uError),
              requiresManualReview: true,
              errorAt: new Date().toISOString(),
            })
          )
        }
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
