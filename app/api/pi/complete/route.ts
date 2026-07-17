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

    // Check: Redis status is pending or handle already-paid case
    if (existingPayment.status?.toLowerCase() === "paid") {
      // Already marked as paid - require both same piPaymentId AND txid
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
            console.log("[Pi Webhook] DB reconciliation successful - clearing requiresDbReconciliation flag")
            
            // Clear the flag since DB is now consistent
            if (isRedisConfigured) {
              await redis.set(
                `payment:${paymentId}`,
                JSON.stringify({
                  ...existingPayment,
                  requiresDbReconciliation: false,
                  dbReconciliationCompletedAt: new Date().toISOString(),
                })
              )
            }
            return NextResponse.json({ success: true, message: "Payment already completed with DB reconciliation" })
          } else {
            console.error("[Pi Webhook] DB reconciliation failed:", dbResult.error)
            // Return 500 to retry - keep the requiresDbReconciliation flag
            return NextResponse.json(
              { error: "Database reconciliation failed on retry", message: "Will retry reconciliation" },
              { status: 500 }
            )
          }
        } else {
          console.log("[Pi Webhook] Payment already paid with same Pi ID and txid - returning 200 without A2U")
          return NextResponse.json({ success: true, message: "Payment already completed" })
        }
      } else {
        console.error("[Pi Webhook] Payment marked paid but Pi ID or txid mismatch")
        return NextResponse.json({ error: "Payment already completed with different identifiers" }, { status: 400 })
      }
    }

    if (existingPayment.status?.toLowerCase() !== "pending") {
      console.error("[Pi Webhook] Unexpected payment status:", existingPayment.status)
      return NextResponse.json({ error: "Unexpected payment status" }, { status: 400 })
    }

    console.log("[Pi Webhook] ✓ All Pi payment verifications passed")

    const txid = clientTxid

    console.log("[Pi Webhook] Calling Pi complete endpoint...")

    // Call Pi API to complete the payment
    const completionResponse = await fetch(
      `https://api.minepi.com/v2/payments/${identifier}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      },
    )

    const completionData = await completionResponse.json().catch(() => ({}))

    // Handle already_completed case
    if (completionResponse.status === 400 && completionData.error?.message?.includes("already_completed")) {
      console.log("[Pi Webhook] Payment already completed on Pi - validating and proceeding")
      // Refetch Pi payment to validate state with full checks
      const revalidateResponse = await fetch(`https://api.minepi.com/v2/payments/${identifier}`, {
        method: "GET",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
      })
      if (!revalidateResponse.ok) {
        console.error("[Pi Webhook] Failed to refetch Pi payment for validation")
        return NextResponse.json({ error: "Failed to validate already-completed payment" }, { status: 400 })
      }
      const revalidatedPayment = await revalidateResponse.json()
      
      // Apply same full verification checks as initial payment
      if (revalidatedPayment.identifier !== identifier) {
        console.error("[Pi Webhook] Refetched payment identifier mismatch")
        return NextResponse.json({ error: "Payment identifier mismatch" }, { status: 400 })
      }
      if (revalidatedPayment.metadata?.paymentId !== paymentId) {
        console.error("[Pi Webhook] Refetched payment metadata mismatch")
        return NextResponse.json({ error: "Payment metadata mismatch" }, { status: 400 })
      }
      if (revalidatedPayment.amount !== existingPayment.amount) {
        console.error("[Pi Webhook] Refetched payment amount mismatch")
        return NextResponse.json({ error: "Payment amount mismatch on revalidation" }, { status: 400 })
      }
      if (revalidatedPayment.transaction?.txid !== clientTxid) {
        console.error("[Pi Webhook] Refetched payment txid mismatch")
        return NextResponse.json({ error: "Payment txid mismatch on revalidation" }, { status: 400 })
      }
      if (revalidatedPayment.direction !== "user_to_app") {
        console.error("[Pi Webhook] Refetched payment direction mismatch")
        return NextResponse.json({ error: "Payment direction mismatch on revalidation" }, { status: 400 })
      }
      if (!revalidatedPayment.status.developer_approved) {
        console.error("[Pi Webhook] Refetched payment not approved")
        return NextResponse.json({ error: "Payment not approved on revalidation" }, { status: 400 })
      }
      if (revalidatedPayment.status.cancelled || revalidatedPayment.status.user_cancelled) {
        console.error("[Pi Webhook] Refetched payment is cancelled")
        return NextResponse.json({ error: "Payment cancelled on revalidation" }, { status: 400 })
      }
      if (!revalidatedPayment.transaction?.verified) {
        console.error("[Pi Webhook] Refetched transaction not verified")
        return NextResponse.json({ error: "Transaction not verified on revalidation" }, { status: 400 })
      }
      if (!revalidatedPayment.status.developer_completed) {
        console.error("[Pi Webhook] Refetched payment not developer_completed")
        return NextResponse.json({ error: "Payment not developer_completed" }, { status: 400 })
      }
      console.log("[Pi Webhook] ✓ Already completed payment passed full verification")
    } else if (!completionResponse.ok) {
      console.error("[Pi Webhook] Pi API completion failed:", completionResponse.status, completionData)
      return NextResponse.json({ error: "Pi API completion failed" }, { status: 400 })
    } else {
      console.log("[Pi Webhook] ✓ Pi API completion successful - validating response data")
      // Validate completionData contains all required fields with correct values
      if (completionData.identifier !== identifier) {
        console.error("[Pi Webhook] Completion response identifier mismatch")
        return NextResponse.json({ error: "Completion identifier mismatch" }, { status: 400 })
      }
      if (completionData.metadata?.paymentId !== paymentId) {
        console.error("[Pi Webhook] Completion response metadata mismatch")
        return NextResponse.json({ error: "Completion metadata mismatch" }, { status: 400 })
      }
      if (completionData.amount !== existingPayment.amount) {
        console.error("[Pi Webhook] Completion response amount mismatch")
        return NextResponse.json({ error: "Completion amount mismatch" }, { status: 400 })
      }
      if (completionData.transaction?.txid !== clientTxid) {
        console.error("[Pi Webhook] Completion response txid mismatch")
        return NextResponse.json({ error: "Completion txid mismatch" }, { status: 400 })
      }
      if (completionData.direction !== "user_to_app") {
        console.error("[Pi Webhook] Completion response direction invalid")
        return NextResponse.json({ error: "Completion direction invalid" }, { status: 400 })
      }
      if (!completionData.status?.developer_approved) {
        console.error("[Pi Webhook] Completion response not approved")
        return NextResponse.json({ error: "Completion not approved" }, { status: 400 })
      }
      if (completionData.status?.cancelled || completionData.status?.user_cancelled) {
        console.error("[Pi Webhook] Completion response is cancelled")
        return NextResponse.json({ error: "Completion is cancelled" }, { status: 400 })
      }
      if (!completionData.transaction?.verified) {
        console.error("[Pi Webhook] Completion response transaction not verified")
        return NextResponse.json({ error: "Completion transaction not verified" }, { status: 400 })
      }
      if (!completionData.status?.developer_completed) {
        console.error("[Pi Webhook] Completion response not developer_completed")
        return NextResponse.json({ error: "Completion not developer_completed" }, { status: 400 })
      }
      console.log("[Pi Webhook] ✓ Completion response passed full validation")
    }

    // ONLY AFTER Pi confirms completion: Mark Redis as paid
    const updatedPayment = {
      ...existingPayment,
      status: "paid" as const,
      paidAt: new Date().toISOString(),
      txid: txid,
      piPaymentId: identifier,
      u2aIdentifier: u2aIdentifier,
      u2aTxid: u2aTxid,
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
    console.log("[Pi Webhook] ✓ Payment marked as PAID in Redis after Pi confirmation")

    // RETURN 200 OK IMMEDIATELY - payment is marked as PAID in Redis
    const response = NextResponse.json({ success: true, message: "Payment completed" })

    // Prepare payment object for transaction recording
    const paymentForRecording = {
      id: existingPayment.id,
      merchantId: merchantId,
      amount: existingPayment.amount,
      note: existingPayment.note || "",
      status: "paid" as const,
      createdAt: createdAt,
      paidAt: new Date().toISOString(),
    }

    // RUN A2U FLOW ONLY AFTER Pi confirms completion and Redis is marked paid
    if (merchantUid) {
      console.log("[A2U-INIT] ✓ Starting A2U transfer - merchantUid found")
      
      // Validate A2U secret is configured
      if (!config.a2uInternalSecret) {
        console.error("[A2U-INIT] A2U_INTERNAL_SECRET not configured - cannot call A2U")
        // Continue without A2U but mark as requiring manual review
        if (isRedisConfigured) {
          await redis.set(
            `payment:${paymentId}`,
            JSON.stringify({
              ...updatedPayment,
              a2uStatus: "error",
              a2uError: "A2U_INTERNAL_SECRET not configured",
              requiresManualReview: true,
              errorAt: new Date().toISOString(),
            })
          )
        }
      } else {
        const a2uUrl = `${config.appUrl}/api/pi/a2u`
        
        try {
          const a2uResponse = await fetch(a2uUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-flashpay-internal-secret": config.a2uInternalSecret,
            },
            body: JSON.stringify({ paymentId }),
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
              `payment:${paymentId}`,
              JSON.stringify({
                ...updatedPayment,
                a2uPaymentId: a2uData.a2uPaymentId,
                a2uStatus: "complete",
                a2uSteps: a2uData.steps,
                a2uTxid: a2uData.txid,
                settlementCompletedAt: new Date().toISOString(),
              })
            )
          }
          
          // ONLY NOW: Record atomic A2U transaction - AFTER Horizon submit succeeded AND Pi complete succeeded
          console.log("[Pi Webhook] ✓ A2U succeeded - NOW recording atomic transaction with merchant balance update")
          console.log("[Pi Webhook] Recording atomic transaction:")
          console.log("[Pi Webhook]   - U2A identifier:", identifier)
          console.log("[Pi Webhook]   - U2A txid:", clientTxid)
          console.log("[Pi Webhook]   - A2U identifier:", a2uData.a2uPaymentId)
          console.log("[Pi Webhook]   - A2U txid:", a2uData.txid)
          
          const dbResult = await recordA2UTransactionAtomic({
            u2aIdentifier: identifier,           // U2A identifier from Pi webhook
            u2aTxid: clientTxid,                 // clientTxid from U2A flow
            a2uIdentifier: a2uData.a2uPaymentId, // A2U identifier from A2U response
            a2uTxid: a2uData.txid,               // Horizon transaction ID from A2U flow
            merchantId: merchantId,
            merchantUid: merchantUid,
            amount: paymentForRecording.amount,
            note: paymentForRecording.note || "A2U Settlement",
            createdAt: createdAtDate,
          })
          
          if (!dbResult.success) {
            console.error("[Pi Webhook] ❌ Database transaction FAILED - payment marked PAID but accounting incomplete")
            console.error("[Pi Webhook] Database error:", dbResult.error)
            
            // Save DB-failed state in Redis for reconciliation
            if (isRedisConfigured) {
              await redis.set(
                `payment:${paymentId}`,
                JSON.stringify({
                  ...updatedPayment,
                  a2uPaymentId: a2uData.a2uPaymentId,
                  a2uTxid: a2uData.txid,
                  u2aIdentifier: identifier,
                  u2aTxid: clientTxid,
                  a2uIdentifier: a2uData.a2uPaymentId,
                  requiresDbReconciliation: true,
                  dbFailedAt: new Date().toISOString(),
                  dbError: dbResult.error,
                })
              )
              console.error("[Pi Webhook] DB-failed state saved to Redis - retry will reconcile DB only")
            }
            
            // Return 500 to trigger retry - payment is PAID, DB will reconcile on next attempt
            return NextResponse.json(
              { error: "Database reconciliation failed", message: "Retry will reconcile DB only" },
              { status: 500 }
            )
          }
          
          console.log("[Pi Webhook] ✅ Atomic transaction committed successfully")
          console.log("[Pi Webhook] - Transaction ID:", dbResult.transactionId)
          console.log("[Pi Webhook] - U2A identifier:", paymentForRecording.id)
          console.log("[Pi Webhook] - A2U identifier:", paymentDTO.identifier)
          console.log("[Pi Webhook] - A2U txid:", a2uData.txid)
          console.log("[Pi Webhook] - Merchant balance updated: +", paymentForRecording.amount, "π")
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
              `payment:${paymentId}`,
              JSON.stringify({
                ...updatedPayment,
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
          
          // For pending A2U (awaiting signing), still record transaction for audit trail but balance won't be settled yet
          // The atomic transaction will only update balance when A2U actually completes
          console.log("[Pi Webhook] A2U pending - recording audit transaction (balance not settled yet)")
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
              `payment:${paymentId}`,
              JSON.stringify({
                ...updatedPayment,
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
            `payment:${paymentId}`,
            JSON.stringify({
              ...updatedPayment,
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
