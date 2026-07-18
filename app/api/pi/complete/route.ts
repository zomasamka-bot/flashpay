import { type NextRequest, NextResponse } from "next/server"
import { redis, isRedisConfigured } from "@/lib/redis"
import { serverConfig } from "@/lib/server-config"
import { publicConfig } from "@/lib/public-config"
import { recordA2UTransactionAtomic } from "@/lib/db"
import { buildA2USuccessResponse } from "@/lib/a2u-response"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/pi/complete
 * 
 * Client-facing endpoint that completes U2A payment verification from Pi.
 * Receives Pi payment identifier and txid from Pi Wallet callback.
 * 
 * SECURITY:
 * - Accepts ONLY piPaymentId + txid from client (verified by Pi Wallet signature)
 * - All trusted payment data (amount, merchant, addresses) from Redis
 * - Uses A2U_INTERNAL_SECRET (from environment, fail-closed) for server-to-server calls
 * 
 * Flow:
 * 1. Verify Pi payment from Redis canonical store
 * 2. If already settled_to_merchant: return 200 (idempotent)
 * 3. Set status to paid_to_app (U2A complete)
 * 4. Call /api/pi/a2u endpoint with A2U_INTERNAL_SECRET to begin settlement
 * 5. Track settlement states: settlement_pending, settled_to_merchant, or settlement_failed
 * 
 * Never downgrades settled_to_merchant back to earlier states.
 */
export async function POST(request: NextRequest) {
  console.log("[Pi Complete] Request received at", new Date().toISOString())

  try {
    // Fail closed: require A2U_INTERNAL_SECRET from environment
    if (!serverConfig.a2uInternalSecret || typeof serverConfig.a2uInternalSecret !== "string") {
      console.error("[Pi Complete] SECURITY: A2U_INTERNAL_SECRET not configured - REJECTING ALL REQUESTS")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    // 1. Parse request - accept ONLY piPaymentId (Pi identifier) + txid (Pi transaction)
    const body = await request.json()
    const { piPaymentId, txid } = body
    
    if (!piPaymentId || !txid) {
      console.error("[Pi Complete] Missing piPaymentId or txid")
      return NextResponse.json({ error: "Missing piPaymentId or txid" }, { status: 400 })
    }

    console.log("[Pi Complete] Processing Pi payment:", piPaymentId, "txid:", txid)

    // 2. Fetch canonical payment state directly from Pi API (not Redis)
    // Redis pi_payment:* keys are never created - fetch from authoritative Pi API source
    if (!serverConfig.isPiApiKeyConfigured) {
      console.error("[Pi Complete] PI_API_KEY not configured")
      return NextResponse.json({ error: "Server not configured" }, { status: 500 })
    }

    if (!isRedisConfigured) {
      console.error("[Pi Complete] Redis not configured")
      return NextResponse.json({ error: "Storage not available" }, { status: 503 })
    }

    console.log("[Pi Complete] Fetching canonical payment from Pi API for piPaymentId:", piPaymentId)
    
    const piApiResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
      method: "GET",
      headers: {
        "Authorization": `Key ${serverConfig.piApiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!piApiResponse.ok) {
      console.error("[Pi Complete] Failed to fetch Pi payment - status:", piApiResponse.status)
      const errorBody = await piApiResponse.text()
      console.error("[Pi Complete] Pi API error:", errorBody)
      return NextResponse.json({ error: "Pi payment verification failed" }, { status: 400 })
    }

    const canonicalPayment = await piApiResponse.json()
    console.log("[Pi Complete] Canonical Pi payment fetched:", {
      identifier: canonicalPayment.identifier,
      hasMetadata: !!canonicalPayment.metadata,
      hasTxid: !!canonicalPayment.transaction?.txid,
      hasStatus: !!canonicalPayment.status,
    })

    // 3. Comprehensive validation of canonical payment from Pi API
    console.log("[Pi Complete] === VALIDATING CANONICAL PAYMENT FROM PI API ===")
    
    // Validate identifier (Pi identifier, not our internal paymentId) matches request
    if (!canonicalPayment.identifier || typeof canonicalPayment.identifier !== "string") {
      console.error("[Pi Complete] Missing or invalid identifier:", canonicalPayment.identifier)
      return NextResponse.json({ error: "Invalid Pi payment identifier" }, { status: 400 })
    }

    if (canonicalPayment.identifier !== piPaymentId) {
      console.error("[Pi Complete] Pi payment identifier mismatch - canonical:", canonicalPayment.identifier, "request:", piPaymentId)
      return NextResponse.json({ error: "Payment identifier mismatch" }, { status: 400 })
    }

    // Validate amount is numeric
    if (!canonicalPayment.amount || typeof canonicalPayment.amount !== "number") {
      console.error("[Pi Complete] Invalid amount in canonical payment:", canonicalPayment.amount)
      return NextResponse.json({ error: "Invalid payment amount" }, { status: 400 })
    }

    // Validate direction is user_to_app (U2A, not app_to_user)
    if (canonicalPayment.direction !== "user_to_app") {
      console.error("[Pi Complete] Invalid direction:", canonicalPayment.direction)
      return NextResponse.json({ error: "Invalid payment direction" }, { status: 400 })
    }

    // Validate cancellation flags from nested status object
    if (canonicalPayment.status?.cancelled === true || canonicalPayment.status?.user_cancelled === true) {
      console.error("[Pi Complete] Payment was cancelled - cancelled:", canonicalPayment.status?.cancelled, "user_cancelled:", canonicalPayment.status?.user_cancelled)
      return NextResponse.json({ error: "Payment was cancelled" }, { status: 400 })
    }

    // Validate developer_approved flag from nested status object
    if (canonicalPayment.status?.developer_approved !== true) {
      console.error("[Pi Complete] Developer did not approve payment - developer_approved:", canonicalPayment.status?.developer_approved)
      return NextResponse.json({ error: "Payment not approved" }, { status: 400 })
    }

    // Validate transaction_verified flag from nested status object
    if (canonicalPayment.status?.transaction_verified !== true) {
      console.error("[Pi Complete] Transaction not verified by Pi - transaction_verified:", canonicalPayment.status?.transaction_verified)
      return NextResponse.json({ error: "Transaction not verified" }, { status: 400 })
    }

    // NOTE: developer_completed flag is checked AFTER calling Pi /complete endpoint (not before)
    // The endpoint may need to call Pi /complete which updates the flag

    // Validate transaction exists and has txid
    const canonicalTxid = canonicalPayment.transaction?.txid
    if (!canonicalTxid || typeof canonicalTxid !== "string") {
      console.error("[Pi Complete] Missing or invalid transaction txid in canonical payment")
      return NextResponse.json({ error: "Invalid transaction ID" }, { status: 400 })
    }

    // Validate transaction txid matches what Pi Wallet sent (u2aTxid)
    if (canonicalTxid !== txid) {
      console.error("[Pi Complete] Transaction txid mismatch - canonical:", canonicalTxid, "wallet:", txid)
      return NextResponse.json({ error: "Transaction verification failed" }, { status: 400 })
    }

    // Derive paymentId ONLY from canonical payment metadata (never trust client)
    const paymentId = canonicalPayment.metadata?.paymentId
    if (!paymentId || typeof paymentId !== "string") {
      console.error("[Pi Complete] Invalid canonical payment - missing or invalid paymentId in metadata")
      return NextResponse.json({ error: "Invalid payment metadata" }, { status: 400 })
    }

    console.log("[Pi Complete] === CANONICAL PAYMENT VALIDATED - deriving paymentId:", paymentId)

    // 3a. If developer_completed is not true, call Pi /complete to mark it completed
    if (canonicalPayment.status?.developer_completed !== true) {
      console.log("[Pi Complete] developer_completed not true yet - calling Pi /complete endpoint...")
      
      try {
        const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}/complete`, {
          method: "POST",
          headers: {
            "Authorization": `Key ${serverConfig.piApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ txid }),
        })

        if (completeResponse.ok) {
          console.log("[Pi Complete] Successfully called Pi /complete - refetching canonical payment")
          
          // Refetch the canonical payment to get updated developer_completed flag
          const refetchResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
            method: "GET",
            headers: {
              "Authorization": `Key ${serverConfig.piApiKey}`,
              "Content-Type": "application/json",
            },
          })

          if (refetchResponse.ok) {
            const refetchedPayment = await refetchResponse.json()
            console.log("[Pi Complete] Refetched payment after /complete call - developer_completed:", refetchedPayment.status?.developer_completed)
            Object.assign(canonicalPayment, refetchedPayment)
          } else {
            console.warn("[Pi Complete] Failed to refetch after /complete - using previous state")
          }
        } else if (completeResponse.status === 400) {
          // Check if already_completed error
          const errorData = await completeResponse.json()
          if (errorData.error === "already_completed") {
            console.log("[Pi Complete] Payment was already completed - refetching canonical payment")
            
            // Refetch to get current state
            const refetchResponse = await fetch(`https://api.minepi.com/v2/payments/${piPaymentId}`, {
              method: "GET",
              headers: {
                "Authorization": `Key ${serverConfig.piApiKey}`,
                "Content-Type": "application/json",
              },
            })

            if (refetchResponse.ok) {
              const refetchedPayment = await refetchResponse.json()
              console.log("[Pi Complete] Refetched payment after already_completed - developer_completed:", refetchedPayment.status?.developer_completed)
              Object.assign(canonicalPayment, refetchedPayment)
            }
          } else {
            console.error("[Pi Complete] Pi /complete failed:", errorData.error)
            return NextResponse.json({ error: "Failed to complete Pi payment", details: errorData.error }, { status: 400 })
          }
        } else {
          console.error("[Pi Complete] Pi /complete returned status:", completeResponse.status)
          return NextResponse.json({ error: "Failed to complete Pi payment" }, { status: 400 })
        }
      } catch (completeError) {
        console.error("[Pi Complete] Error calling Pi /complete:", completeError)
        return NextResponse.json({ error: "Failed to complete Pi payment" }, { status: 500 })
      }
    }

    // 3b. NOW verify that developer_completed is true (after calling Pi /complete if needed)
    if (canonicalPayment.status?.developer_completed !== true) {
      console.error("[Pi Complete] Payment still not marked completed by developer after /complete call - developer_completed:", canonicalPayment.status?.developer_completed)
      return NextResponse.json({ error: "Payment completion failed" }, { status: 400 })
    }

    // Load the actual payment record using the derived paymentId
    const paymentKey = `payment:${paymentId}`
    const paymentData = await redis.get(paymentKey)
    
    if (!paymentData) {
      console.error("[Pi Complete] Payment record not found:", paymentId)
      return NextResponse.json({ error: "Payment record not found" }, { status: 404 })
    }

    const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData
    console.log("[Pi Complete] Payment record loaded - ID:", paymentId, "Status:", payment.status)

    // Validate local payment amount matches canonical amount
    if (canonicalPayment.amount !== payment.amount) {
      console.error("[Pi Complete] Amount mismatch - canonical:", canonicalPayment.amount, "local:", payment.amount)
      return NextResponse.json({ error: "Amount verification failed" }, { status: 400 })
    }

    console.log("[Pi Complete] === ALL VALIDATIONS PASSED ===")

    // 4. Handle retry cases and idempotency - NEVER downgrade settled_to_merchant
    console.log("[Pi Complete] Current payment status:", payment.status)
    
    if (payment.status === "settled_to_merchant") {
      console.log("[Pi Complete] Already settled to merchant - returning current state (NO DOWNGRADE)")
      return NextResponse.json({
        status: "settled_to_merchant",
        paymentId,
        u2aTxid: payment.u2aTxid || txid,
      })
    }

    if (payment.status === "settlement_failed") {
      console.log("[Pi Complete] Settlement previously failed - requires manual review")
      return NextResponse.json({
        status: "settlement_failed",
        paymentId,
        error: payment.a2uError || "Settlement failed",
        requiresManualReview: true,
      })
    }

    if (payment.status === "settlement_pending" && payment.a2uPaymentId) {
      // Reattempt to complete the SAME A2U transfer
      console.log("[Pi Complete] Retry: reattempting settlement_pending transfer")
      console.log("[Pi Complete] Reusing A2U payment ID:", payment.a2uPaymentId)
      
      // Call A2U endpoint with ONLY paymentId (strict validation enforced server-side)
      const a2uCompleteResponse = await fetch(`${publicConfig.appUrl}/api/pi/a2u`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-flashpay-internal-secret": serverConfig.a2uInternalSecret,
        },
        body: JSON.stringify({
          paymentId,
        }),
      })

      if (a2uCompleteResponse.ok) {
        const a2uData = await a2uCompleteResponse.json()
        if (a2uData.success && a2uData.txid) {
          // DB insert succeeded - mark as settled
          await redis.set(
            `payment:${paymentId}`,
            JSON.stringify({
              ...payment,
              status: "settled_to_merchant",
              a2uTxid: a2uData.txid,
              settlementCompletedAt: new Date().toISOString(),
            })
          )
        console.log("[Pi Complete] Retry succeeded - marked settled_to_merchant")
        // Return canonical response from authoritative Redis checkpoint
        const canonicalResponse = await buildA2USuccessResponse(paymentId)
        if (!canonicalResponse) {
          console.error("[Pi Complete] ❌ Failed to build canonical response for settled payment")
          return NextResponse.json(
            { error: "Response building failed - data corruption detected" },
            { status: 500 }
          )
        }
        return NextResponse.json(canonicalResponse)
        }
      }
      
      // Return unified response for settlement_pending state
      const processingResponse = await buildA2USuccessResponse(paymentId)
      if (!processingResponse) {
        console.error("[Pi Complete] ❌ Failed to build processing response")
        return NextResponse.json(
          { error: "Response building failed" },
          { status: 500 }
        )
      }
      return NextResponse.json(processingResponse)
    }

    // 4. Only allow completion from pending state
    if (payment.status !== "pending") {
      console.error("[Pi Complete] Cannot complete from status:", payment.status)
      return NextResponse.json(
        { error: "Invalid payment status for completion", status: payment.status },
        { status: 400 }
      )
    }

    // 5. Persist verified identifiers from canonical Pi API payment
    // Use txid (Pi Wallet callback), not canonicalTxid, as the single authoritative U2A txid
    console.log("[Pi Complete] Persisting verified identifiers - piPaymentId:", piPaymentId, "u2aTxid:", txid)
    
    const updatedPayment = {
      ...payment,
      status: "paid_to_app",
      piPaymentId,
      u2aTxid: txid,  // Single txid field from Pi Wallet callback (verified against canonical)
      paidAt: new Date().toISOString(),
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
    console.log("[Pi Complete] Payment persisted - status: paid_to_app, txid verified against canonical Pi payment")

    // 6. Call A2U endpoint to begin settlement with validated paymentId
    console.log("[Pi Complete] Initiating A2U settlement for paymentId:", paymentId)
    
    const a2uResponse = await fetch(`${publicConfig.appUrl}/api/pi/a2u`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flashpay-internal-secret": serverConfig.a2uInternalSecret,
      },
      body: JSON.stringify({ paymentId }),
    })

    const a2uData = await a2uResponse.json()

    // Handle A2U responses
    if (a2uResponse.status === 202) {
      // A2U pending (createPayment succeeded, signing in progress)
      console.log("[Pi Complete] A2U pending - payment created but signing not yet complete")
      
      // Atomically save A2U identifiers before returning
      if (a2uData.a2uPaymentId) {
        const settlementPendingPayment = {
          ...updatedPayment,
          status: "settlement_pending",
          a2uPaymentId: a2uData.a2uPaymentId,
          a2uFromAddress: a2uData.fromAddress,
          a2uToAddress: a2uData.toAddress,
          settlementStartedAt: new Date().toISOString(),
        }
        
        await redis.set(`payment:${paymentId}`, JSON.stringify(settlementPendingPayment))
        console.log("[Pi Complete] Saved A2U identifiers, status: settlement_pending")
      }

      // Return unified response for settlement_pending state
      const processingResponse = await buildA2USuccessResponse(paymentId)
      if (!processingResponse) {
        console.error("[Pi Complete] ❌ Failed to build processing response")
        return NextResponse.json(
          { error: "Response building failed" },
          { status: 500 }
        )
      }
      return NextResponse.json(processingResponse, { status: 202 })
    }

    if (!a2uResponse.ok || !a2uData.success) {
      console.error("[Pi Complete] A2U failed:", a2uData.error)
      
      // Save A2U error state for manual review - preserve verified identifiers
      const failedPayment = {
        ...updatedPayment,
        status: "settlement_failed",
        a2uError: a2uData.error,
        a2uPaymentId: a2uData.a2uPaymentId,
        settlementAttemptedAt: new Date().toISOString(),
        requiresManualReview: true,
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(failedPayment))

      return NextResponse.json(
        {
          status: "settlement_failed",
          paymentId,
          error: a2uData.error,
          requiresManualReview: true,
        },
        { status: 400 }
      )
    }

    // 9. A2U succeeded - IMMEDIATELY persist identifiers AND financial data to Redis BEFORE DB call
    // This ensures idempotent recovery: if DB fails, we can retry with same A2U transfer
    console.log("[Pi Complete] A2U succeeded, persisting identifiers AND financial data BEFORE DB call")
    console.log("[Pi Complete] Horizon txid:", a2uData.txid)
    console.log("[Pi Complete] Horizon fee charged:", a2uData.feeCharged)
    console.log("[Pi Complete] Customer amount (from A2U):", a2uData.customerAmount)
    console.log("[Pi Complete] Merchant amount (from A2U):", a2uData.merchantAmount)

    // CRITICAL: Validate all financial fields exist BEFORE persisting - NO FALLBACKS
    // Missing any field is a critical error requiring manual review
    if (
      a2uData.customerAmount === undefined ||
      a2uData.customerAmount === null ||
      typeof a2uData.customerAmount !== "number"
    ) {
      console.error("[Pi Complete] CRITICAL: A2U response missing customerAmount - cannot proceed")
      return NextResponse.json(
        { error: "Incomplete A2U response: missing customerAmount", manual_review_required: true },
        { status: 422 }
      )
    }

    if (
      a2uData.merchantAmount === undefined ||
      a2uData.merchantAmount === null ||
      typeof a2uData.merchantAmount !== "number"
    ) {
      console.error("[Pi Complete] CRITICAL: A2U response missing merchantAmount - cannot proceed")
      return NextResponse.json(
        { error: "Incomplete A2U response: missing merchantAmount", manual_review_required: true },
        { status: 422 }
      )
    }

    if (
      a2uData.horizonFeeCharged === undefined ||
      a2uData.horizonFeeCharged === null ||
      typeof a2uData.horizonFeeCharged !== "number"
    ) {
      console.error("[Pi Complete] CRITICAL: A2U response missing horizonFeeCharged - cannot proceed")
      return NextResponse.json(
        { error: "Incomplete A2U response: missing horizonFeeCharged", manual_review_required: true },
        { status: 422 }
      )
    }

    // CRITICAL: Save A2U identifiers + authoritative financial data atomically BEFORE calling DB
    // This is the recovery state: if anything fails after this, retry uses stored identifiers and amounts
    // Calculation: appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
    const calculatedAppNetImpact = a2uData.customerAmount - a2uData.merchantAmount - a2uData.horizonFeeCharged

    const settlementCompletePayment = {
      ...updatedPayment,
      status: "settlement_pending",
      a2uPaymentId: a2uData.a2uPaymentId,
      a2uTxid: a2uData.txid,
      a2uFromAddress: a2uData.fromAddress,
      a2uToAddress: a2uData.toAddress,
      customerAmount: a2uData.customerAmount, // EXACT: verified U2A amount from A2U
      merchantAmount: a2uData.merchantAmount, // EXACT: actual Horizon transfer amount
      horizonFeeCharged: a2uData.horizonFeeCharged, // EXACT: actual Horizon fee
      appCommission: 0, // Explicit: app commission (default 0)
      appNetImpact: calculatedAppNetImpact, // EXACT: customerAmount - merchantAmount - horizonFeeCharged
      settlementCompletedAt: new Date().toISOString(),
    }
    
    await redis.set(`payment:${paymentId}`, JSON.stringify(settlementCompletePayment))
    console.log("[Pi Complete] ✓ A2U identifiers persisted to Redis (recovery state)")

    // 10. Re-read checkpoint from Redis BEFORE any DB write to ensure authoritative data
    // This guarantees we use the exact values persisted by A2U success
    console.log("[Pi Complete] Re-reading checkpoint from Redis before DB write")
    const checkpointJson = await redis.get(`payment:${paymentId}`)
    if (!checkpointJson) {
      console.error("[Pi Complete] CRITICAL: Checkpoint disappeared from Redis")
      return NextResponse.json({ error: "Checkpoint lost - manual review required" }, { status: 500 })
    }

    const checkpoint = JSON.parse(checkpointJson)
    
    // Validate checkpoint has all required financial fields
    if (
      !checkpoint.customerAmount ||
      !checkpoint.merchantAmount ||
      checkpoint.horizonFeeCharged === undefined ||
      !checkpoint.merchantId ||
      !checkpoint.merchantUid
    ) {
      console.error("[Pi Complete] CRITICAL: Checkpoint missing required fields for accounting")
      console.error("[Pi Complete] Missing:", {
        customerAmount: !checkpoint.customerAmount,
        merchantAmount: !checkpoint.merchantAmount,
        horizonFeeCharged: checkpoint.horizonFeeCharged === undefined,
        merchantId: !checkpoint.merchantId,
        merchantUid: !checkpoint.merchantUid,
      })
      return NextResponse.json({ error: "Checkpoint incomplete - manual review required" }, { status: 500 })
    }

    // CRITICAL VALIDATION: All required identifiers and financial data must exist before DB write
    if (!checkpoint.piPaymentId) {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Missing piPaymentId (u2aIdentifier)")
      return NextResponse.json({ error: "Missing piPaymentId - manual review required" }, { status: 500 })
    }
    if (!checkpoint.a2uPaymentId) {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Missing a2uPaymentId (a2uIdentifier)")
      return NextResponse.json({ error: "Missing a2uPaymentId - manual review required" }, { status: 500 })
    }
    if (!checkpoint.u2aTxid) {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Missing u2aTxid")
      return NextResponse.json({ error: "Missing u2aTxid - manual review required" }, { status: 500 })
    }
    if (!checkpoint.a2uTxid) {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Missing a2uTxid")
      return NextResponse.json({ error: "Missing a2uTxid - manual review required" }, { status: 500 })
    }
    if (typeof checkpoint.customerAmount !== "number") {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Invalid customerAmount:", checkpoint.customerAmount)
      return NextResponse.json({ error: "Invalid customerAmount - manual review required" }, { status: 500 })
    }
    if (typeof checkpoint.merchantAmount !== "number") {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Invalid merchantAmount:", checkpoint.merchantAmount)
      return NextResponse.json({ error: "Invalid merchantAmount - manual review required" }, { status: 500 })
    }
    if (typeof checkpoint.horizonFeeCharged !== "number") {
      console.error("[Pi Complete] ❌ AUDIT FAILURE: Invalid horizonFeeCharged:", checkpoint.horizonFeeCharged)
      return NextResponse.json({ error: "Invalid horizonFeeCharged - manual review required" }, { status: 500 })
    }

    // Now attempt DB transaction - use AUTHORITATIVE values from checkpoint
    // CRITICAL: These values came from verified A2U response and saved to Redis
    console.log("[Pi Complete] Recording atomic A2U transaction to database")
    console.log("[Pi Complete] AUTHORITATIVE FINANCIAL DATA FROM CHECKPOINT:")
    console.log("[Pi Complete]   - customerAmount (verified U2A):", checkpoint.customerAmount)
    console.log("[Pi Complete]   - merchantAmount (actual A2U):", checkpoint.merchantAmount)
    console.log("[Pi Complete]   - horizonFeeCharged (actual fee):", checkpoint.horizonFeeCharged)
    console.log("[Pi Complete]   - appCommission:", checkpoint.appCommission)
    console.log("[Pi Complete]   - appNetImpact:", checkpoint.appNetImpact)
    console.log("[Pi Complete]   - Merchant ID:", checkpoint.merchantId)
    console.log("[Pi Complete]   - Merchant UID:", checkpoint.merchantUid)
    
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: checkpoint.piPaymentId,          // AUDIT: Only piPaymentId, validated above
      u2aTxid: checkpoint.u2aTxid,                    // AUDIT: Validated above
      a2uIdentifier: checkpoint.a2uPaymentId,         // AUDIT: Only a2uPaymentId, validated above
      a2uTxid: checkpoint.a2uTxid,                    // AUDIT: Validated above
      merchantId: checkpoint.merchantId,               // AUDIT: From Redis checkpoint, validated above
      merchantUid: checkpoint.merchantUid,             // AUDIT: From Redis checkpoint, validated above
      customerAmount: checkpoint.customerAmount,       // AUDIT: Validated above, no fallback
      merchantAmount: checkpoint.merchantAmount,       // AUDIT: Validated above, no fallback
      horizonFeeCharged: checkpoint.horizonFeeCharged, // AUDIT: Validated above, no fallback
      appCommission: checkpoint.appCommission,         // Optional, may be undefined
    })

    if (dbResult.success) {
      console.log("[Pi Complete] ✓ Atomic transaction recorded")
      console.log("[Pi Complete] Accounting reconciliation (from checkpoint - EXACT VALUES):")
      console.log("[Pi Complete]   - Customer amount (verified):", checkpoint.customerAmount)
      console.log("[Pi Complete]   - Merchant credited:", checkpoint.merchantAmount)
      console.log("[Pi Complete]   - Horizon fee charged:", checkpoint.horizonFeeCharged)
      console.log("[Pi Complete]   - App net impact:", checkpoint.appNetImpact)
      console.log("[Pi Complete]   - Merchant balance updated in database (idempotent receipt)")
      
      // Verify calculation matches
      const verifyAppNetImpact = checkpoint.customerAmount - checkpoint.merchantAmount - checkpoint.horizonFeeCharged
      if (Math.abs(verifyAppNetImpact - checkpoint.appNetImpact) > 0.0001) {
        console.warn("[Pi Complete] WARNING: appNetImpact calculation mismatch - recorded:", checkpoint.appNetImpact, "recalculated:", verifyAppNetImpact)
      }
      
      // CRITICAL: Only mark settled AFTER DB commit succeeds
      const finalPayment = {
        ...settlementCompletePayment,
        status: "settled_to_merchant",
        settledAt: new Date().toISOString(),
        piCompletionPending: false, // Pi /complete finished
        piCompleted: true, // Settlement fully completed
        dbRecorded: true, // CRITICAL: Set ONLY after DB commit succeeds
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(finalPayment))
    console.log("[Pi Complete] ✓ Payment fully settled to merchant - accounting complete")
    console.log("[Pi Complete] Settlement checkpoint: piCompleted=true, piCompletionPending=false")
    
    // Return canonical response from authoritative Redis checkpoint
    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      console.error("[Pi Complete] ❌ Failed to build canonical response for settled payment")
      return NextResponse.json(
        { error: "Response building failed - data corruption detected" },
        { status: 500 }
      )
    }
    return NextResponse.json(canonicalResponse)
    } else {
      console.error("[Pi Complete] DB transaction failed:", dbResult.error)
      console.error("[Pi Complete] CRITICAL: A2U succeeded but DB write failed")
      console.error("[Pi Complete] Known state: a2uTxid =", checkpoint.a2uTxid, "a2uPaymentId =", checkpoint.a2uPaymentId)
      
      // DB failed but A2U succeeded - checkpoint already persisted with full financial data
      // Mark requiresDbReconciliation so retry knows to complete DB only using checkpoint values
      const reconciliationNeededPayment = {
        ...checkpoint,
        status: "settlement_pending", // Stay in pending until DB succeeds
        requiresDbReconciliation: true,
        dbRecorded: false, // CRITICAL: DB failed - mark as not recorded
        dbError: dbResult.error,
        dbAttemptedAt: new Date().toISOString(),
        a2uSucceededAt: new Date().toISOString(), // Mark when A2U was confirmed successful
      }
      
      await redis.set(`payment:${paymentId}`, JSON.stringify(reconciliationNeededPayment))
      console.log("[Pi Complete] ⚠️  DB FAILED but A2U SUCCEEDED - marked requiresDbReconciliation")
      console.log("[Pi Complete] Manual review needed for payment:", paymentId)
      console.log("[Pi Complete] Known values for recovery:")
      console.log("[Pi Complete]   - a2uTxid:", checkpoint.a2uTxid)
      console.log("[Pi Complete]   - customerAmount:", checkpoint.customerAmount)
      console.log("[Pi Complete]   - merchantAmount:", checkpoint.merchantAmount)
      console.log("[Pi Complete]   - horizonFeeCharged:", checkpoint.horizonFeeCharged)

      return NextResponse.json(
        {
          status: "settlement_pending",
          paymentId,
          requiresDbReconciliation: true,
          a2uTxid: checkpoint.a2uTxid,
          customerAmount: checkpoint.customerAmount,
          merchantAmount: checkpoint.merchantAmount,
          horizonFeeCharged: checkpoint.horizonFeeCharged,
          message: "CRITICAL: A2U succeeded but DB write failed - manual review required. A2U transaction is known and will not be resubmitted.",
        },
        { status: 202 }
      )
    }
  } catch (error) {
    console.error("[Pi Complete] Error:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    )
  }
}
