import { type NextRequest, NextResponse } from "next/server"
import { config } from "@/lib/config"
import { redis, isRedisConfigured } from "@/lib/redis"
import * as StellarSDK from "@stellar/stellar-sdk"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface A2UPaymentRequest {
  paymentId: string
  merchantId: string
  merchantUid: string
  accessToken: string
  amount: number
  memo: string
}

/**
 * ============================================================================
 * App-to-User Transfer (A2U) - Send funds to merchant wallet
 * ============================================================================
 * 
 * Called AFTER a U2A payment is completed by the customer.
 * Transfers the payment amount from FlashPay app account to the merchant's Pi wallet.
 *
 * REQUIREMENTS:
 * 1. merchantUid must be populated from merchant's Pi.authenticate() call
 *    - Stored in unifiedStore.state.merchant.uid
 *    - Passed when creating a payment via /api/payments
 *    - Retrieved from Redis when payment completes
 *
 * 2. Pi API Key must be configured (PI_API_KEY env var)
 *
 * 3. Payment object in Redis must include:
 *    - merchantId (for tracking)
 *    - merchantUid (for A2U transfer - CRITICAL)
 *    - amount (funds to transfer)
 *
 * FLOW:
 * 1. Customer pays merchant via Pi Wallet (U2A) → /api/pi/complete
 * 2. Payment marked as PAID in Redis
 * 3. A2U transfer initiated with merchantUid
 * 4. Pi API creates payment to merchant's wallet
 * 5. Merchant receives funds
 */

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
    const { paymentId, merchantId, merchantUid, accessToken, amount, memo } = body

    console.log("[Pi A2U] ===== A2U REQUEST RECEIVED =====")
    console.log("[Pi A2U] Full body:", JSON.stringify(body, null, 2))
    console.log("[Pi A2U] merchantUid value:", merchantUid)
    console.log("[Pi A2U] accessToken:", accessToken ? "PROVIDED" : "MISSING")
    
    // CRITICAL: Retrieve payment context from Redis (stored by approve webhook)
    // This ensures from_address and to_address are available
    let paymentContextFromRedis: any = null
    if (isRedisConfigured && paymentId) {
      try {
        const paymentContextKey = `pi:payment:${paymentId}`
        const contextData = await redis.get(paymentContextKey)
        if (contextData) {
          paymentContextFromRedis = typeof contextData === "string" ? JSON.parse(contextData) : contextData
          console.log("[Pi A2U] ✓ Retrieved payment context from Redis (approve webhook storage)")
          console.log("[Pi A2U]   - from_address:", paymentContextFromRedis.from_address)
          console.log("[Pi A2U]   - to_address:", paymentContextFromRedis.to_address)
        }
      } catch (contextError) {
        console.warn("[Pi A2U] Could not retrieve payment context from Redis:", contextError)
        // Continue - from_address and to_address may be in request body
      }
    }

    // ===== ENVIRONMENT VERIFICATION =====
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== ENVIRONMENT VERIFICATION =====")
    console.log("[Pi A2U] PI_API_KEY loaded:", config.piApiKey ? "YES" : "NO")
    if (config.piApiKey) {
      console.log("[Pi A2U] PI_API_KEY first 8 chars:", config.piApiKey.substring(0, 8))
      console.log("[Pi A2U] PI_API_KEY last 8 chars:", config.piApiKey.substring(config.piApiKey.length - 8))
      console.log("[Pi A2U] PI_API_KEY length:", config.piApiKey.length)
    } else {
      console.error("[Pi A2U] ❌ PI_API_KEY IS NOT CONFIGURED!")
    }
    console.log("[Pi A2U] API base URL: https://api.minepi.com")
    console.log("[Pi A2U] Environment: Production (Testnet support via app credentials)")
    console.log("[Pi A2U] App URL: " + config.appUrl)
    console.log("[Pi A2U]")

    // Validate required fields
    if (!merchantUid || merchantUid.trim() === "") {
      console.error("[Pi A2U] ❌ CRITICAL: Merchant UID is empty - cannot send funds")
      console.error("[Pi A2U] Request was:", JSON.stringify(body))
      return NextResponse.json(
        { error: "Merchant UID is required for fund transfer", success: false },
        { status: 400 }
      )
    }

    if (!accessToken || accessToken.trim() === "") {
      console.error("[Pi A2U] ❌ CRITICAL: accessToken is missing - cannot verify UID")
      return NextResponse.json(
        { error: "accessToken is required to verify UID", success: false },
        { status: 400 }
      )
    }

    // ===== CRITICAL: Verify UID with Pi /v2/me before A2U createPayment =====
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== VERIFYING UID WITH PI /V2/ME BEFORE CREATEPAYMENT =====")
    console.log("[Pi A2U] Payment ID:", paymentId)
    console.log("[Pi A2U] Merchant UID to verify:", merchantUid)
    
    let verifyResponse
    try {
      verifyResponse = await fetch("https://api.minepi.com/v2/me", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      })
      
      console.log("[Pi A2U] /v2/me HTTP Status:", verifyResponse.status, verifyResponse.statusText)
    } catch (verifyError) {
      console.error("[Pi A2U] ❌ /v2/me verification fetch exception")
      console.error("[Pi A2U] Error:", verifyError instanceof Error ? verifyError.message : String(verifyError))
      return NextResponse.json(
        {
          error: "Failed to verify uid with Pi Network",
          details: verifyError instanceof Error ? verifyError.message : String(verifyError),
          step: "verify_uid",
          success: false,
        },
        { status: 500 }
      )
    }

    if (!verifyResponse.ok) {
      const verifyError = await verifyResponse.text()
      console.error("[Pi A2U] ❌ /v2/me verification FAILED")
      console.error("[Pi A2U] HTTP Status:", verifyResponse.status)
      console.error("[Pi A2U] Error Response:", verifyError)
      return NextResponse.json(
        {
          error: "UID verification failed - accessToken may be invalid or expired",
          details: verifyError,
          piStatus: verifyResponse.status,
          step: "verify_uid",
          success: false,
        },
        { status: verifyResponse.status }
      )
    }

    const verifiedUser = await verifyResponse.json()
    console.log("[Pi A2U] ✓ /v2/me verification SUCCEEDED")
    console.log("[Pi A2U] ===== FRESH /V2/ME RESPONSE AT A2U TIME =====")
    console.log(JSON.stringify(verifiedUser, null, 2))
    console.log("[Pi A2U] ===== END FRESH /V2/ME RESPONSE =====")
    
    // CRITICAL: Compare the fresh /v2/me response with the UID we're about to use
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== ACCESSTOKEN VALIDITY CHECK AT A2U TIME =====")
    console.log("[Pi A2U] accessToken provided to A2U endpoint:", accessToken ? "YES" : "NO")
    console.log("[Pi A2U] accessToken validity (via /v2/me response): VALID - returned 200")
    console.log("[Pi A2U] Fresh /v2/me app_id:", verifiedUser.app_id || "NOT PROVIDED")
    console.log("[Pi A2U] Fresh /v2/me uid:", verifiedUser.uid)
    console.log("[Pi A2U] Fresh /v2/me username:", verifiedUser.username)
    console.log("[Pi A2U]")
    console.log("[Pi A2U] NOTE: This is the CURRENT user context in Pi Browser at A2U execution time")
    console.log("[Pi A2U] NOTE: The fresh UID should match what was stored at payment creation")
    console.log("[Pi A2U] NOTE: If they don't match, the user context changed between payment creation and A2U")
    
    // Log app context from /v2/me response
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== APP CONTEXT FROM /V2/ME =====")
    console.log("[Pi A2U] User app_id:", verifiedUser.app_id || "NOT PROVIDED IN RESPONSE")
    console.log("[Pi A2U] User uid:", verifiedUser.uid)
    console.log("[Pi A2U] User username:", verifiedUser.username)
    console.log("[Pi A2U] Credentials scopes:", verifiedUser.scopes)
    console.log("[Pi A2U]")
    
    // Log API key app context - this should match the /v2/me app_id for A2U to work
    console.log("[Pi A2U] ===== APP_ID VERIFICATION =====")
    const meAppId = verifiedUser.app_id
    console.log("[Pi A2U] app_id from /v2/me:", meAppId || "NOT PROVIDED")
    console.log("[Pi A2U] NOTE: The app_id must match the app registered in Pi Developer Portal")
    console.log("[Pi A2U] NOTE: PI_API_KEY must belong to the same app_id")
    console.log("[Pi A2U] NOTE: A2U createPayment uses PI_API_KEY, which must have A2U enabled for this app")
    console.log("[Pi A2U]")
    
    const verifiedUid = verifiedUser.uid
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== UID COMPARISON =====")
    console.log("[Pi A2U] Verified UID from /v2/me:", verifiedUid)
    console.log("[Pi A2U] Original merchantUid:", merchantUid)
    console.log("[Pi A2U] UIDs match:", verifiedUid === merchantUid)
    
    if (verifiedUid !== merchantUid) {
      console.error("[Pi A2U] ❌ CRITICAL: UID MISMATCH!")
      console.error("[Pi A2U] Verified UID from /v2/me:", verifiedUid)
      console.error("[Pi A2U] merchantUid from payment:", merchantUid)
      console.error("[Pi A2U] This suggests the UID context has changed or accessToken is from a different user")
      return NextResponse.json(
        {
          error: "UID verification failed - uid mismatch",
          details: `Verified UID (${verifiedUid}) does not match payment UID (${merchantUid})`,
          step: "uid_mismatch",
          success: false,
        },
        { status: 401 }
      )
    }
    
    console.log("[Pi A2U] ✓ UID VERIFICATION SUCCESSFUL")
    console.log("[Pi A2U] Proceeding with A2U createPayment using verified UID")
    console.log("[Pi A2U]")


    // CRITICAL: A2U payment creation - use Server API Key (NOT user accessToken)
    // Request body format per Pi documentation
    const requestBody = {
      payment: {
        amount: amount,
        memo: memo || `FlashPay settlement for ${paymentId}`,
        metadata: {
          paymentId,
          merchantId,
          type: "a2u_settlement",
          timestamp: new Date().toISOString(),
        },
        uid: merchantUid,
      },
    }
    
    console.log("[Pi A2U] ===== SENDING TO PI PRODUCTION API (A2U Creation) =====")
    console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments")
    console.log("[Pi A2U] Authorization: Key [" + config.piApiKey.substring(0, 8) + "..." + config.piApiKey.substring(config.piApiKey.length - 4) + "]")
    console.log("[Pi A2U] Content-Type: application/json")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] CRITICAL APP CONTEXT FOR A2U:")
    console.log("[Pi A2U] - PI_API_KEY must be registered in Pi Developer Portal")
    console.log("[Pi A2U] - API Key must belong to the same app as verified in /v2/me")
    console.log("[Pi A2U] - A2U must be enabled for this app in Pi settings")
    console.log("[Pi A2U] - payment.uid must be valid for this app context")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== EXACT REQUEST BODY =====")
    console.log(JSON.stringify(requestBody, null, 2))
    console.log("[Pi A2U] ===== REQUEST DETAILS =====")
    console.log("[Pi A2U] payment.amount:", requestBody.payment.amount)
    console.log("[Pi A2U] payment.memo:", requestBody.payment.memo)
    console.log("[Pi A2U] payment.uid:", requestBody.payment.uid)
    console.log("[Pi A2U] payment.uid length:", requestBody.payment.uid.length)

    let a2uPayment: any // Declare early for both new and ongoing payment flows
    let a2uResponse: any
    try {
      console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== CRITICAL: APP CONTEXT MISMATCH INVESTIGATION =====")
    console.log("[Pi A2U] User's app context (from /v2/me):")
    console.log("[Pi A2U]   - app_id:", verifiedUser.app_id || "NOT PROVIDED BY PI")
    console.log("[Pi A2U]   - uid:", verifiedUser.uid)
    console.log("[Pi A2U]   - username:", verifiedUser.username)
    console.log("[Pi A2U]")
    console.log("[Pi A2U] Server PI_API_KEY context:")
    console.log("[Pi A2U]   - PI_API_KEY configured:", config.piApiKey ? "YES" : "NO")
    console.log("[Pi A2U]   - PI_API_KEY is registered to a specific app in Pi Developer Portal")
    console.log("[Pi A2U]   - That app_id must match user's app_id from /v2/me")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] If user_not_found occurs:")
    console.log("[Pi A2U]   → user's app_id ≠ PI_API_KEY's app_id")
    console.log("[Pi A2U]   → This is an app context mismatch")
    console.log("[Pi A2U]   → Check Pi Developer Portal: is this app's API Key being used?")
    console.log("[Pi A2U]")
    console.log("[Pi A2U] SOLUTION STEPS:")
    console.log("[Pi A2U]   1. Go to Pi Developer Portal → Your App Settings")
    console.log("[Pi A2U]   2. Find the app_id (shown as 'App ID')")
    console.log("[Pi A2U]   3. Ensure this matches the user's app_id above")
    console.log("[Pi A2U]   4. If not, either:")
    console.log("[Pi A2U]      a) Generate new API Key for the correct app, OR")
    console.log("[Pi A2U]      b) Switch to the app that matches the current PI_API_KEY")
    console.log("[Pi A2U] ===== END APP CONTEXT INVESTIGATION =====")
    console.log("[Pi A2U]")
    console.log("[Pi A2U]")
      a2uResponse = await fetch("https://api.minepi.com/v2/payments", {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      })
      console.log("[Pi A2U] HTTP Status:", a2uResponse.status, a2uResponse.statusText)
    } catch (fetchError) {
      console.error("[Pi A2U] ❌ FETCH EXCEPTION")
      console.error("[Pi A2U] Error:", fetchError instanceof Error ? fetchError.message : String(fetchError))
      return NextResponse.json(
        {
          error: "Network error - could not reach Pi API",
          details: fetchError instanceof Error ? fetchError.message : String(fetchError),
          success: false,
        },
        { status: 500 }
      )
    }

    console.log("[Pi A2U] ===== PI API RESPONSE =====")
    if (!a2uResponse.ok) {
      const errorText = await a2uResponse.text()
      let errorData
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { raw: errorText }
      }
      
      console.error("[Pi A2U] ❌ STEP 1: createPayment FAILED")
      console.error("[Pi A2U] HTTP Status:", a2uResponse.status)
      console.error("[Pi A2U] Status Text:", a2uResponse.statusText)
      console.error("[Pi A2U] Error Response:", JSON.stringify(errorData, null, 2))
      
      // CRITICAL: Log the exact UID that was rejected
      console.error("[Pi A2U]")
      console.error("[Pi A2U] ===== CRITICAL: UID STORED VS UID SENT TO A2U =====")
      console.error("[Pi A2U] UID from request body (sent by frontend/payment):", merchantUid)
      console.error("[Pi A2U] UID from fresh /v2/me (current at A2U time):", verifiedUser.uid)
      console.error("[Pi A2U] Fresh /v2/me app_id:", verifiedUser.app_id || "NOT PROVIDED")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] ===== APP_ID MISMATCH DIAGNOSIS =====")
      console.error("[Pi A2U] User is authenticated via Pi Browser under app_id:", verifiedUser.app_id || "NOT PROVIDED")
      console.error("[Pi A2U] PI_API_KEY on server is registered under app_id: UNKNOWN (registered in Pi Dev Portal)")
      console.error("[Pi A2U] createPayment uses PI_API_KEY, which is looking for this user in ITS OWN app context")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] POSSIBLE CAUSES:")
      console.error("[Pi A2U] 1. PI_API_KEY belongs to a different app than what user authenticated under")
      console.error("[Pi A2U] 2. You recently changed PI_API_KEY on Vercel but it's for a different app")
      console.error("[Pi A2U] 3. User is in App Context X, but PI_API_KEY is registered to App Context Y")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] If UIDs match but Pi still rejects:")
      console.error("[Pi A2U]   → Issue is NOT the UID itself")
      console.error("[Pi A2U]   → Issue IS the app context mismatch between:")
      console.error("[Pi A2U]       a) User's authenticated app (what /v2/me shows)")
      console.error("[Pi A2U]       b) PI_API_KEY's app (registered in Pi Dev Portal)")
      console.error("[Pi A2U]")
      console.error("[Pi A2U] This happens when:")
      console.error("[Pi A2U]   - Pi Browser loads app under App ID 'X'")
      console.error("[Pi A2U]   - User authenticates under App ID 'X'")
      console.error("[Pi A2U]   - User's UID belongs to App ID 'X' only")
      console.error("[Pi A2U]   - BUT PI_API_KEY belongs to App ID 'Y'")
      console.error("[Pi A2U]   - So A2U createPayment (using PI_API_KEY) can't find user in App ID 'Y'")
      console.error("[Pi A2U]")
      
      // Check if there's already an ongoing payment for this user
      if (errorData.code === "ongoing_payment_found" || errorText.includes("ongoing_payment")) {
        console.warn("[Pi A2U] ⚠️  ONGOING PAYMENT DETECTED")
        console.warn("[Pi A2U] Pi is blocking new A2U creation - there's already an unfinished payment")
        console.warn("[Pi A2U] Full error response:", JSON.stringify(errorData, null, 2))
        
        // Extract the ongoing payment identifier from various possible response paths
        const ongoingPaymentId = 
          errorData.payment?.identifier ||           // Most likely: payment.identifier
          errorData.identifier ||                     // Direct identifier field
          errorData.payment_id ||                     // payment_id field
          errorData.data?.identifier ||               // Nested in data
          errorData.data?.payment?.identifier         // Deeply nested
        
        console.warn("[Pi A2U] Extracted ongoing payment identifier:", ongoingPaymentId || "EXTRACTION FAILED")
        console.warn("[Pi A2U] Full error structure for debugging:")
        console.warn("[Pi A2U]   errorData.payment:", JSON.stringify(errorData.payment))
        console.warn("[Pi A2U]   errorData.identifier:", errorData.identifier)
        console.warn("[Pi A2U]   errorData.payment_id:", errorData.payment_id)
        console.warn("[Pi A2U]   errorData.data:", JSON.stringify(errorData.data))
        
        if (ongoingPaymentId) {
          console.warn("[Pi A2U] ✅ Successfully extracted ongoing payment ID")
          console.warn("[Pi A2U] Reusing ongoing payment instead of creating new one")
          console.warn("[Pi A2U] Ongoing A2U Payment ID:", ongoingPaymentId)
          console.warn("[Pi A2U] Fetching ongoing payment details from Pi...")
          console.warn("[Pi A2U]")
          
          try {
            // Fetch the ongoing payment details from Pi API
            const getPaymentResponse = await fetch(`https://api.minepi.com/v2/payments/${ongoingPaymentId}`, {
              method: "GET",
              headers: {
                Authorization: `Key ${config.piApiKey}`,
                "Content-Type": "application/json",
              },
            })
            
            if (!getPaymentResponse.ok) {
              const getError = await getPaymentResponse.text()
              console.error("[Pi A2U] ❌ Failed to fetch ongoing payment details")
              console.error("[Pi A2U] Status:", getPaymentResponse.status)
              console.error("[Pi A2U] Error:", getError)
              
              return NextResponse.json({
                error: "Could not fetch ongoing payment details",
                piPaymentId: ongoingPaymentId,
                details: getError,
                success: false,
              }, { status: getPaymentResponse.status })
            }
            
            const ongoingPaymentDetails = await getPaymentResponse.json()
            console.log("[Pi A2U] ✓ Ongoing payment details retrieved")
            console.log("[Pi A2U] Details:", JSON.stringify(ongoingPaymentDetails, null, 2))
            console.log("[Pi A2U]")
            
            // CRITICAL: Check ongoing payment status before auto-reusing
            console.log("[Pi A2U] ===== CHECKING ONGOING PAYMENT STATUS =====")
            console.log("[Pi A2U] Payment status:", ongoingPaymentDetails.status)
            console.log("[Pi A2U] Developer approved:", ongoingPaymentDetails.developer_approved)
            console.log("[Pi A2U] Transaction verified:", ongoingPaymentDetails.transaction_verified)
            console.log("[Pi A2U] Developer completed:", ongoingPaymentDetails.developer_completed)
            console.log("[Pi A2U] Created at:", ongoingPaymentDetails.created_at)
            
            // Check if this is a stuck payment (not approved or not completed)
            const isStuckPayment = 
              ongoingPaymentDetails.status === "FAILED" ||
              ongoingPaymentDetails.status === "CANCELLED" ||
              (ongoingPaymentDetails.developer_approved === false && ongoingPaymentDetails.status === "PENDING") ||
              (ongoingPaymentDetails.developer_completed === false && ongoingPaymentDetails.status === "PENDING")
            
            if (isStuckPayment) {
              console.error("[Pi A2U] ❌ ONGOING PAYMENT IS STUCK")
              console.error("[Pi A2U] Status:", ongoingPaymentDetails.status)
              console.error("[Pi A2U] Developer approved:", ongoingPaymentDetails.developer_approved)
              console.error("[Pi A2U] Developer completed:", ongoingPaymentDetails.developer_completed)
              console.error("[Pi A2U] This payment cannot be reused - it requires cancellation or manual intervention")
              
              return NextResponse.json({
                error: "Ongoing payment is stuck and cannot be reused",
                piPaymentId: ongoingPaymentId,
                paymentStatus: ongoingPaymentDetails.status,
                developerApproved: ongoingPaymentDetails.developer_approved,
                developerCompleted: ongoingPaymentDetails.developer_completed,
                requiresManualIntervention: true,
                success: false,
              }, { status: 409 })
            }
            
            console.log("[Pi A2U] ✓ Ongoing payment status is valid - proceeding with metadata validation")
            console.log("[Pi A2U]")
            
            // CRITICAL: Validate that this ongoing payment matches the CURRENT request
            console.log("[Pi A2U] ===== VALIDATING ONGOING PAYMENT METADATA =====")
            console.log("[Pi A2U] Current request details:")
            console.log("[Pi A2U]   - paymentId (from request):", paymentId)
            console.log("[Pi A2U]   - merchantId (from request):", merchantId)
            console.log("[Pi A2U]   - uid (from request):", merchantUid)
            console.log("[Pi A2U]   - amount (from request):", amount)
            console.log("[Pi A2U]")
            console.log("[Pi A2U] Ongoing payment details:")
            console.log("[Pi A2U]   - metadata:", JSON.stringify(ongoingPaymentDetails.metadata, null, 2))
            console.log("[Pi A2U]   - amount:", ongoingPaymentDetails.amount)
            console.log("[Pi A2U]   - user_uid:", ongoingPaymentDetails.user_uid)
            console.log("[Pi A2U]   - uid:", ongoingPaymentDetails.uid)
            
            // Extract metadata from ongoing payment
            const ongoingMetadata = ongoingPaymentDetails.metadata || {}
            const ongoingPaymentIdFromMetadata = ongoingMetadata.paymentId
            const ongoingMerchantIdFromMetadata = ongoingMetadata.merchantId
            const ongoingUidFromMetadata = ongoingMetadata.uid
            const ongoingAmountFromMetadata = ongoingMetadata.amount
            
            // Check if the ongoing payment matches the current request on all four critical fields
            const metadataPaymentIdMatches = ongoingPaymentIdFromMetadata === paymentId
            const metadataMerchantIdMatches = ongoingMerchantIdFromMetadata === merchantId
            const metadataUidMatches = ongoingUidFromMetadata === merchantUid
            const amountMatches = parseInt(ongoingPaymentDetails.amount) === amount
            
            console.log("[Pi A2U] Validation results:")
            console.log("[Pi A2U]   - paymentId match:", metadataPaymentIdMatches, `(${ongoingPaymentIdFromMetadata} === ${paymentId})`)
            console.log("[Pi A2U]   - merchantId match:", metadataMerchantIdMatches, `(${ongoingMerchantIdFromMetadata} === ${merchantId})`)
            console.log("[Pi A2U]   - uid match:", metadataUidMatches, `(${ongoingUidFromMetadata} === ${merchantUid})`)
            console.log("[Pi A2U]   - amount match:", amountMatches, `(${ongoingPaymentDetails.amount} === ${amount})`)
            console.log("[Pi A2U]")
            
            if (!metadataPaymentIdMatches || !metadataMerchantIdMatches || !metadataUidMatches || !amountMatches) {
              console.error("[Pi A2U] ❌ ONGOING PAYMENT METADATA MISMATCH")
              console.error("[Pi A2U] This ongoing payment is for a DIFFERENT request and cannot be reused")
              console.error("[Pi A2U] Ongoing payment is STALE:")
              console.error("[Pi A2U]   - Expected paymentId:", paymentId, "but found:", ongoingPaymentIdFromMetadata)
              console.error("[Pi A2U]   - Expected merchantId:", merchantId, "but found:", ongoingMerchantIdFromMetadata)
              console.error("[Pi A2U]   - Expected uid:", merchantUid, "but found:", ongoingUidFromMetadata)
              console.error("[Pi A2U]   - Expected amount:", amount, "but found:", ongoingPaymentDetails.amount)
              console.error("[Pi A2U] This stale A2U must be marked separately and not completed as current settlement")
              
              return NextResponse.json({
                error: "Ongoing payment is for a different request - cannot reuse",
                piPaymentId: ongoingPaymentId,
                paymentIdMismatch: !metadataPaymentIdMatches,
                merchantIdMismatch: !metadataMerchantIdMatches,
                uidMismatch: !metadataUidMatches,
                amountMismatch: !amountMatches,
                expectedPaymentId: paymentId,
                foundPaymentId: ongoingPaymentIdFromMetadata,
                expectedMerchantId: merchantId,
                foundMerchantId: ongoingMerchantIdFromMetadata,
                expectedUid: merchantUid,
                foundUid: ongoingUidFromMetadata,
                expectedAmount: amount,
                foundAmount: ongoingPaymentDetails.amount,
                requiresManualReview: true,
                success: false,
              }, { status: 409 })
            }
            
            console.log("[Pi A2U] ✅ METADATA VALIDATION PASSED")
            console.log("[Pi A2U] This ongoing payment matches the current request on all fields - safe to reuse")
            console.log("[Pi A2U]")
            
            // Use the ongoing payment details to continue
            const a2uPayment = ongoingPaymentDetails
            const isOngoingPayment = true
            
            // Log payment details
            console.log("[Pi A2U] ✓ STEP 1: Using existing ongoing A2U payment")
            console.log("[Pi A2U] Payment ID:", a2uPayment.identifier)
            console.log("[Pi A2U] From address:", a2uPayment.from_address)
            console.log("[Pi A2U] To address:", a2uPayment.to_address)
            console.log("[Pi A2U] Amount:", a2uPayment.amount)
            console.log("[Pi A2U]")
            
            // Now check for private seed and proceed with signing if available
            const piPrivateSeed = process.env.PI_PRIVATE_SEED
            
            console.log("[Pi A2U] ===== PRIVATE SEED CHECK =====")
            console.log("[Pi A2U] PI_PRIVATE_SEED loaded:", piPrivateSeed ? "YES" : "NO")
            if (piPrivateSeed) {
              console.log("[Pi A2U] PI_PRIVATE_SEED length:", piPrivateSeed.length, "characters")
            }
            console.log("[Pi A2U]")
            
            if (!piPrivateSeed) {
              console.warn("[Pi A2U] ⚠️  PI_PRIVATE_SEED not configured")
              console.warn("[Pi A2U] Ongoing payment found but cannot proceed without private key")
              console.warn("[Pi A2U] Status: PENDING_SIGNING")
              
              if (isRedisConfigured) {
                try {
                  const a2uKey = `a2u:${paymentId}`
                  await redis.set(
                    a2uKey,
                    JSON.stringify({
                      originalPaymentId: paymentId,
                      piPaymentId: ongoingPaymentId,
                      merchantId,
                      merchantUid,
                      amount,
                      settlementStatus: "PENDING_SIGNING",
                      status: "reusing_ongoing",
                      createdAt: new Date().toISOString(),
                    })
                  )
                } catch (error) {
                  console.warn("[Pi A2U] Failed to store reference:", error)
                }
              }
              
              return NextResponse.json({
                success: false,
                message: "Ongoing payment found - awaiting blockchain signing",
                status: "pending_signing",
                a2uPaymentId: ongoingPaymentId,
                amount,
                details: "PI_PRIVATE_SEED required for signing",
                timestamp: new Date().toISOString(),
              }, { status: 202 })
            }
            
            // Private seed IS available - continue with signing code for the ongoing payment
            console.log("[Pi A2U] ✅ PI_PRIVATE_SEED detected - proceeding with blockchain signing for ongoing payment")
            console.log("[Pi A2U]")
            console.log("[Pi A2U] ===== STEP 2: BLOCKCHAIN TRANSACTION SIGNING =====")
            console.log("[Pi A2U] Starting blockchain signing process...")
            console.log("[Pi A2U] Private seed length:", piPrivateSeed.length)
            console.log("[Pi A2U]")
            
            // === BEGIN SIGNING IMPLEMENTATION ===
            try {
              // Pi Network uses Stellar's testnet for testing
              const networkPassphrase = "Pi Testnet"
              
              console.log("[Pi A2U] Creating Stellar keypair from PI_PRIVATE_SEED")
              const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
              const appPublicKey = appKeypair.publicKey()
              
              console.log("[Pi A2U] App wallet address from seed:", appPublicKey)
              console.log("[Pi A2U] Verifying address matches from_address:")
              console.log("[Pi A2U]   from_address:", a2uPayment.from_address)
              console.log("[Pi A2U]   derived address:", appPublicKey)
              
              if (appPublicKey !== a2uPayment.from_address) {
                console.error("[Pi A2U] ❌ ADDRESS MISMATCH")
                console.error("[Pi A2U] The PI_PRIVATE_SEED does not match the app wallet address from Pi")
                
                return NextResponse.json({
                  error: "Private seed does not match app wallet address",
                  step: "key_derivation",
                  derivedAddress: appPublicKey,
                  expectedAddress: a2uPayment.from_address,
                  success: false,
                }, { status: 400 })
              }
              
              console.log("[Pi A2U] ✓ Address verification passed")
              
              // Get server instance for Pi Testnet
              console.log("[Pi A2U] Connecting to Pi Testnet Horizon server")
              const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
                allowHttp: false,
              })
              
              console.log("[Pi A2U] Fetching account information from Horizon")
              const sourceAccount = await horizonServer.loadAccount(appPublicKey)
              console.log("[Pi A2U] ✓ Account loaded")
              console.log("[Pi A2U] Account sequence:", sourceAccount.sequenceNumber())
              
              // CRITICAL: Fetch dynamic base fee from Horizon (not fixed BASE_FEE)
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== FETCHING DYNAMIC FEE FROM HORIZON =====")
              let baseFee: string
              let usedFee: string
              try {
                const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
                baseFee = String(baseFeeFromHorizon)
                // Use 2x base fee to ensure transaction is accepted
                usedFee = (parseInt(baseFeeFromHorizon) * 2).toString()
                console.log("[Pi A2U] ✓ Dynamic fee fetched from Horizon")
                console.log("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
                console.log("[Pi A2U] Using fee (2x base):", usedFee, "stroops")
              } catch (feeError) {
                console.error("[Pi A2U] ❌ Failed to fetch dynamic fee from Horizon")
                console.error("[Pi A2U] Error:", feeError instanceof Error ? feeError.message : String(feeError))
                console.error("[Pi A2U] Falling back to BASE_FEE constant")
                baseFee = String(StellarSDK.BASE_FEE)
                usedFee = (parseInt(StellarSDK.BASE_FEE) * 2).toString()
                console.log("[Pi A2U] Fallback base fee:", baseFee, "stroops")
                console.log("[Pi A2U] Fallback used fee:", usedFee, "stroops")
              }
              console.log("[Pi A2U]")
              
              // Build the transaction
              console.log("[Pi A2U] Building Stellar transaction")
              const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
                fee: usedFee,
                networkPassphrase: networkPassphrase,
              })
              
              // Add payment operation
              builder.addOperation(
                StellarSDK.Operation.payment({
                  destination: a2uPayment.to_address,
                  asset: StellarSDK.Asset.native(),
                  amount: a2uPayment.amount.toString(),
                })
              )
              
              // Add memo using the Pi payment identifier
              builder.addMemo(StellarSDK.Memo.text(a2uPayment.identifier.substring(0, 28)))
              
              // Set timeout
              builder.setTimeout(StellarSDK.TimeoutInfinite)
              
              const transaction = builder.build()
              console.log("[Pi A2U] ✓ Transaction built")
              console.log("[Pi A2U] Transaction hash:", transaction.hash().toString("hex"))
              
              // Sign the transaction
              console.log("[Pi A2U] Signing transaction with app private key")
              transaction.sign(appKeypair)
              console.log("[Pi A2U] ✓ Transaction signed")
              
              // Get XDR envelope
              const txEnvelope = transaction.toEnvelope().toXDR()
              const txXDR = txEnvelope.toString("base64")
              console.log("[Pi A2U] Transaction XDR generated")
              console.log("[Pi A2U] XDR length:", txXDR.length, "characters")
              
              // CRITICAL STEP 3: Submit signed XDR to Horizon/Stellar SDK to get TXID
              // This MUST be done via Horizon, not directly to Pi API
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== STEP 3: SUBMIT SIGNED TRANSACTION TO HORIZON =====")
              console.log("[Pi A2U] Submitting XDR to Horizon server (Stellar testnet)...")
              
              let txidFromHorizon: string
              try {
                const submitResult = await horizonServer.submitTransaction(transaction)
                console.log("[Pi A2U] ✓ Horizon submission succeeded")
                console.log("[Pi A2U] Horizon response:", JSON.stringify(submitResult, null, 2))
                
                txidFromHorizon = submitResult.hash
                console.log("[Pi A2U] Transaction ID from Horizon:", txidFromHorizon)
                console.log("[Pi A2U] ✓ TXID extracted successfully")
              } catch (horizonError) {
                const errorMsg = horizonError instanceof Error ? horizonError.message : String(horizonError)
                console.error("[Pi A2U] ❌ STEP 3 FAILED: Horizon submission error")
                console.error("[Pi A2U] Error message:", errorMsg)
                console.error("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
                console.error("[Pi A2U] Fee used for transaction:", usedFee, "stroops")
                
                // Log detailed error response from Horizon
                if (horizonError && typeof horizonError === "object") {
                  const err = horizonError as any
                  
                  // Log response data if available
                  if (err.response && err.response.data) {
                    console.error("[Pi A2U] Horizon response.data:", JSON.stringify(err.response.data, null, 2))
                  }
                  
                  // Log status code
                  if (err.response && err.response.status) {
                    console.error("[Pi A2U] HTTP Status Code:", err.response.status)
                  }
                  
                  // Log extras (result_codes, result_xdr) - THIS IS CRITICAL FOR DEBUGGING
                  if (err.response && err.response.data && err.response.data.extras) {
                    console.error("[Pi A2U] Horizon extras:", JSON.stringify(err.response.data.extras, null, 2))
                    
                    if (err.response.data.extras.result_codes) {
                      console.error("[Pi A2U] Result codes:", err.response.data.extras.result_codes)
                    }
                    
                    if (err.response.data.extras.result_xdr) {
                      console.error("[Pi A2U] Result XDR:", err.response.data.extras.result_xdr)
                    }
                  }
                  
                  // Log raw error object
                  console.error("[Pi A2U] Full error object:", JSON.stringify(err, null, 2))
                }
                
                return NextResponse.json({
                  error: "Failed to submit signed transaction to Horizon/Stellar network",
                  step: "horizonSubmit",
                  piPaymentId: a2uPayment.identifier,
                  details: errorMsg,
                  baseFee,
                  usedFee,
                  success: false,
                }, { status: 500 })
              }
              
              // Now that we have the TXID from Horizon, we can proceed to complete the A2U payment
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== STEP 4: SUBMIT TXID TO PI /COMPLETE =====")
              console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments/" + a2uPayment.identifier + "/complete")
              console.log("[Pi A2U] Sending TXID to Pi /complete endpoint...")
              
              const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}/complete`, {
                method: "POST",
                headers: {
                  Authorization: `Key ${config.piApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  txid: txidFromHorizon,
                }),
              })
              
              console.log("[Pi A2U] Pi /complete response status:", completeResponse.status, completeResponse.statusText)
              
              if (!completeResponse.ok) {
                const completeError = await completeResponse.text()
                console.error("[Pi A2U] ❌ STEP 4 FAILED: Pi /complete returned error")
                console.error("[Pi A2U] HTTP Status:", completeResponse.status)
                console.error("[Pi A2U] Error Response:", completeError)
                
                // This is a partial failure - Stellar transaction succeeded but Pi acknowledgement failed
                console.warn("[Pi A2U] ⚠️  PARTIAL SUCCESS: Transaction on Stellar succeeded (TXID: " + txidFromHorizon + ")")
                console.warn("[Pi A2U] But Pi API /complete failed - merchant balance may not update")
                
                return NextResponse.json({
                  error: "Failed to complete A2U payment on Pi backend",
                  step: "piComplete",
                  piPaymentId: a2uPayment.identifier,
                  txid: txidFromHorizon,
                  details: completeError,
                  piStatus: completeResponse.status,
                  partialSuccess: true,
                  success: false,
                }, { status: completeResponse.status })
              }
              
              const completeData = await completeResponse.json()
              console.log("[Pi A2U] ✓ STEP 4: Pi /complete - SUCCESS")
              console.log("[Pi A2U] Complete response:", JSON.stringify(completeData, null, 2))
              
              console.log("[Pi A2U]")
              console.log("[Pi A2U] ===== ✅ A2U TRANSFER COMPLETE =====")
              console.log("[Pi A2U] All steps completed successfully for ONGOING payment:")
              console.log("[Pi A2U]   1. reused existing ongoing payment")
              console.log("[Pi A2U]   2. build and sign transaction: success")
              console.log("[Pi A2U]   3. submit to Horizon: success (txid:", txidFromHorizon + ")")
              console.log("[Pi A2U]   4. complete on Pi backend: success")
              console.log("[Pi A2U] Merchant wallet has received funds")
              
              // Store A2U payment reference in Redis as COMPLETE
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
                      status: "complete",
                      step1: "reused_ongoing",
                      step2: "transaction_signed_success",
                      step3: "horizon_submit_success",
                      step4: "pi_complete_success",
                      txid: txidFromHorizon,
                      completedAt: new Date().toISOString(),
                    })
                  )
                  console.log("[Pi A2U] ✓ A2U payment marked as COMPLETE in Redis")
                } catch (error) {
                  console.warn("[Pi A2U] Failed to update A2U status in Redis (non-blocking):", error)
                }
              }
              
              return NextResponse.json({
                success: true,
                message: "A2U transfer completed successfully - ongoing payment completed and merchant received funds",
                status: "complete",
                a2uPaymentId: a2uPayment.identifier,
                steps: {
                  reuseExisting: "success",
                  sign: "success",
                  horizonSubmit: "success",
                  piComplete: "success",
                },
                txid: txidFromHorizon,
                amount,
                merchantUid: merchantUid.substring(0, 10) + "...",
                timestamp: new Date().toISOString(),
              })
              
            } catch (signingError) {
              console.error("[Pi A2U] ❌ BLOCKCHAIN SIGNING/SUBMISSION FAILED")
              console.error("[Pi A2U] Error:", signingError instanceof Error ? signingError.message : String(signingError))
              console.error("[Pi A2U] Stack:", signingError instanceof Error ? signingError.stack : "no stack")
              
              return NextResponse.json({
                error: "Blockchain signing or submission failed",
                step: "blockchain_operation",
                details: signingError instanceof Error ? signingError.message : String(signingError),
                success: false,
              }, { status: 500 })
            }
            // === END SIGNING IMPLEMENTATION ==
            
          } catch (error) {
            console.error("[Pi A2U] ❌ Error handling ongoing payment")
            console.error("[Pi A2U] Error:", error instanceof Error ? error.message : String(error))
            
            return NextResponse.json({
              error: "Failed to process ongoing payment",
              details: error instanceof Error ? error.message : String(error),
              success: false,
            }, { status: 500 })
          }
          
          // If we reach here with private seed available, continue to signing code
          // Do NOT return - let code fall through to signing implementation
        } else {
          // Could not extract identifier - log full response for diagnosis
          console.error("[Pi A2U] ❌ FAILED TO EXTRACT ONGOING PAYMENT IDENTIFIER")
          console.error("[Pi A2U] Error response structure did not contain payment.identifier")
          console.error("[Pi A2U] Full error response for diagnosis:", JSON.stringify(errorData, null, 2))
          console.error("[Pi A2U] Response keys:", Object.keys(errorData))
          
          return NextResponse.json(
            {
              error: "Ongoing payment found but identifier could not be extracted",
              details: errorData,
              piStatus: a2uResponse.status,
              success: false,
              diagnosis: "Check error response structure for payment.identifier location",
            },
            { status: a2uResponse.status }
          )
        }
      }
      
      // Not an ongoing_payment_found error - return actual error
      console.error("[Pi A2U] ===== DIAGNOSIS =====")
      console.error("[Pi A2U] The merchantUid that was sent:", merchantUid)
      console.error("[Pi A2U] Error code:", errorData.code || "not provided")
      
      return NextResponse.json(
        {
          error: "Failed to initiate fund transfer to merchant",
          details: errorData,
          piStatus: a2uResponse.status,
          success: false,
          sentUid: merchantUid,
        },
        { status: a2uResponse.status }
      )
    }

    a2uPayment = await a2uResponse.json()
    console.log("[Pi A2U] ✓ STEP 1: createPayment - SUCCESS")
    console.log("[Pi A2U] ===== FULL CREATE PAYMENT RESPONSE =====")
    console.log(JSON.stringify(a2uPayment, null, 2))
    console.log("[Pi A2U] ===== END CREATE RESPONSE =====")
    console.log("[Pi A2U] Pi payment identifier:", a2uPayment.identifier)
    console.log("[Pi A2U] Pi payment status:", a2uPayment.status)
    console.log("[Pi A2U] Pi network:", a2uPayment.network || "not specified")
    console.log("[Pi A2U] From address (app wallet):", a2uPayment.from_address)
    console.log("[Pi A2U] To address (merchant wallet):", a2uPayment.to_address)
    console.log("[Pi A2U] Amount:", a2uPayment.amount)
    console.log("[Pi A2U] Transaction at this stage:", a2uPayment.transaction || "null (will be populated after submit)")
    
    // Ensure we have required payment data
    if (!a2uPayment.identifier) {
      console.error("[Pi A2U] ❌ STEP 1 INCOMPLETE: No identifier returned from createPayment")
      console.error("[Pi A2U] Cannot proceed without payment identifier")
      return NextResponse.json(
        {
          error: "createPayment succeeded but no identifier was returned",
          step: "createPayment",
          details: JSON.stringify(a2uPayment),
          success: false,
        },
        { status: 500 }
      )
    }

    if (!a2uPayment.from_address || !a2uPayment.to_address) {
      console.error("[Pi A2U] ❌ STEP 1 INCOMPLETE: Missing wallet addresses")
      console.error("[Pi A2U] from_address:", a2uPayment.from_address)
      console.error("[Pi A2U] to_address:", a2uPayment.to_address)
      return NextResponse.json(
        {
          error: "createPayment missing wallet addresses",
          step: "createPayment",
          details: JSON.stringify(a2uPayment),
          success: false,
        },
        { status: 500 }
      )
    }
    
    // CRITICAL STEP 2: Build and submit the blockchain transaction
    // The app must sign the transaction using its private seed and submit it to the Stellar network
    console.log("[Pi A2U]")
    console.log("[Pi A2U] ===== STEP 2: BUILDING & SUBMITTING BLOCKCHAIN TRANSACTION =====")
    console.log("[Pi A2U] From address (app wallet):", a2uPayment.from_address)
    console.log("[Pi A2U] To address (merchant wallet):", a2uPayment.to_address)
    console.log("[Pi A2U] Amount to transfer:", a2uPayment.amount, "Pi")
    console.log("[Pi A2U] Network:", a2uPayment.network)
    console.log("[Pi A2U]")
    
    // Check if app wallet private seed is configured for signing
    const piPrivateSeed = process.env.PI_PRIVATE_SEED
    
    console.log("[Pi A2U] ===== PRIVATE SEED CHECK =====")
    console.log("[Pi A2U] PI_PRIVATE_SEED loaded:", piPrivateSeed ? "YES" : "NO")
    if (piPrivateSeed) {
      console.log("[Pi A2U] PI_PRIVATE_SEED length:", piPrivateSeed.length, "characters")
    }
    console.log("[Pi A2U]")
    
    if (!piPrivateSeed) {
      console.warn("[Pi A2U] ⚠️  PI_PRIVATE_SEED not configured")
      console.warn("[Pi A2U] A2U payment created successfully but blockchain signing requires private seed")
      console.warn("[Pi A2U] Marking A2U settlement as PENDING_SIGNING - requires manual completion or secure seed configuration")
      console.warn("[Pi A2U]")
      console.warn("[Pi A2U] A2U Status: PENDING_SIGNING")
      console.warn("[Pi A2U] Pi Payment ID:", a2uPayment.identifier)
      console.warn("[Pi A2U] From:", a2uPayment.from_address)
      console.warn("[Pi A2U] To:", a2uPayment.to_address)
      console.warn("[Pi A2U] Amount:", a2uPayment.amount, "Pi")
      
      // Store A2U payment in pending state for manual review/signing
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
              status: "pending_signing",
              fromAddress: a2uPayment.from_address,
              toAddress: a2uPayment.to_address,
              network: a2uPayment.network,
              step1: "createPayment_success",
              step2: "signing_not_configured",
              step3: "pending",
              createdAt: new Date().toISOString(),
              requiresManualReview: true,
              note: "Awaiting PI_PRIVATE_SEED configuration for blockchain signing",
            })
          )
          console.log("[Pi A2U] A2U payment stored with PENDING_SIGNING status in Redis")
        } catch (error) {
          console.warn("[Pi A2U] Failed to store A2U reference (non-blocking):", error)
        }
      }
      
      // Return 202 Accepted - createPayment succeeded, awaiting blockchain signing
      return NextResponse.json({
        success: false, // A2U not complete
        message: "A2U createPayment successful - awaiting blockchain signing",
        status: "pending_signing",
        a2uPaymentId: a2uPayment.identifier,
        step1: "createPayment_success",
        step2: "signing_not_configured",
        step3: "pending",
        fromAddress: a2uPayment.from_address,
        toAddress: a2uPayment.to_address,
        amount,
        network: a2uPayment.network,
        details: "PI_PRIVATE_SEED environment variable required for blockchain signing",
        requiresManualReview: true,
        timestamp: new Date().toISOString(),
      }, { status: 202 }) // 202 Accepted - processing but not complete
    }
    
    console.log("[Pi A2U] ✅ PI_PRIVATE_SEED is configured and available")
    console.log("[Pi A2U] ===== STEP 2: BLOCKCHAIN TRANSACTION SIGNING =====")
    console.log("[Pi A2U] Starting blockchain signing process...")
    console.log("[Pi A2U] Private seed length:", piPrivateSeed.length)
    console.log("[Pi A2U]")
    
    // STEP 2: Build and sign the blockchain transaction
    // This requires Stellar SDK to build a transaction and sign it with the app's private key
    console.log("[Pi A2U] STEP 2 - Build and sign Stellar transaction")
    console.log("[Pi A2U]   From:", a2uPayment.from_address)
    console.log("[Pi A2U]   To:", a2uPayment.to_address)
    console.log("[Pi A2U]   Amount:", a2uPayment.amount, "Pi")
    console.log("[Pi A2U]   Memo:", a2uPayment.identifier)
    console.log("[Pi A2U]")
    
    try {
      // Pi Network uses Stellar's testnet for testing
      // Network passphrase for Pi Testnet (based on Pi's Stellar integration)
      const networkPassphrase = "Pi Testnet"
      
      console.log("[Pi A2U] Creating Stellar keypair from PI_PRIVATE_SEED")
      const appKeypair = StellarSDK.Keypair.fromSecret(piPrivateSeed)
      const appPublicKey = appKeypair.publicKey()
      
      console.log("[Pi A2U] App wallet address from seed:", appPublicKey)
      console.log("[Pi A2U] Verifying address matches from_address:")
      console.log("[Pi A2U]   from_address:", a2uPayment.from_address)
      console.log("[Pi A2U]   derived address:", appPublicKey)
      
      if (appPublicKey !== a2uPayment.from_address) {
        console.error("[Pi A2U] ❌ ADDRESS MISMATCH")
        console.error("[Pi A2U] The PI_PRIVATE_SEED does not match the app wallet address from Pi")
        console.error("[Pi A2U] Private seed derives to:", appPublicKey)
        console.error("[Pi A2U] Expected app address:", a2uPayment.from_address)
        
        return NextResponse.json({
          error: "Private seed does not match app wallet address",
          step: "key_derivation",
          derivedAddress: appPublicKey,
          expectedAddress: a2uPayment.from_address,
          success: false,
        }, { status: 400 })
      }
      
      console.log("[Pi A2U] ✓ Address verification passed")
      
      // Get server instance for Pi Testnet
      console.log("[Pi A2U] Connecting to Pi Testnet Horizon server")
      const horizonServer = new StellarSDK.Horizon.Server("https://api.testnet.minepi.com", {
        allowHttp: false,
      })
      
      console.log("[Pi A2U] Fetching account information from Horizon")
      const sourceAccount = await horizonServer.loadAccount(appPublicKey)
      console.log("[Pi A2U] ✓ Account loaded")
      console.log("[Pi A2U] Account sequence:", sourceAccount.sequenceNumber())
      
      // CRITICAL: Fetch dynamic base fee from Horizon (not fixed BASE_FEE)
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== FETCHING DYNAMIC FEE FROM HORIZON =====")
      let baseFee: string
      let usedFee: string
      try {
        const baseFeeFromHorizon = await horizonServer.fetchBaseFee()
        baseFee = String(baseFeeFromHorizon)
        // Use 2x base fee to ensure transaction is accepted
        usedFee = (parseInt(baseFeeFromHorizon) * 2).toString()
        console.log("[Pi A2U] ✓ Dynamic fee fetched from Horizon")
        console.log("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
        console.log("[Pi A2U] Using fee (2x base):", usedFee, "stroops")
      } catch (feeError) {
        console.error("[Pi A2U] ❌ Failed to fetch dynamic fee from Horizon")
        console.error("[Pi A2U] Error:", feeError instanceof Error ? feeError.message : String(feeError))
        console.error("[Pi A2U] Falling back to BASE_FEE constant")
        baseFee = String(StellarSDK.BASE_FEE)
        usedFee = (parseInt(StellarSDK.BASE_FEE) * 2).toString()
        console.log("[Pi A2U] Fallback base fee:", baseFee, "stroops")
        console.log("[Pi A2U] Fallback used fee:", usedFee, "stroops")
      }
      console.log("[Pi A2U]")
      
      // Build the transaction
      console.log("[Pi A2U] Building Stellar transaction")
      const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
        fee: usedFee,
        networkPassphrase: networkPassphrase,
      })
      
      // Add payment operation
      builder.addOperation(
        StellarSDK.Operation.payment({
          destination: a2uPayment.to_address,
          asset: StellarSDK.Asset.native(), // Pi uses native asset
          amount: a2uPayment.amount.toString(),
        })
      )
      
      // Add memo using the Pi payment identifier
      builder.addMemo(StellarSDK.Memo.text(a2uPayment.identifier.substring(0, 28)))
      
      // Set timeout
      builder.setTimeout(StellarSDK.TimeoutInfinite)
      
      const transaction = builder.build()
      console.log("[Pi A2U] ✓ Transaction built")
      console.log("[Pi A2U] Transaction hash:", transaction.hash().toString("hex"))
      
      // Sign the transaction
      console.log("[Pi A2U] Signing transaction with app private key")
      transaction.sign(appKeypair)
      console.log("[Pi A2U] ✓ Transaction signed")
      
      // Get XDR envelope
      const txEnvelope = transaction.toEnvelope().toXDR()
      const txXDR = txEnvelope.toString("base64")
      console.log("[Pi A2U] Transaction XDR generated")
      console.log("[Pi A2U] XDR length:", txXDR.length, "characters")
      
      // CRITICAL STEP 3: Submit signed XDR to Horizon/Stellar SDK to get TXID
      // This MUST be done via Horizon, not directly to Pi API
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== STEP 3: SUBMIT SIGNED TRANSACTION TO HORIZON =====")
      console.log("[Pi A2U] Submitting XDR to Horizon server (Stellar testnet)...")
      
      let txidFromHorizon: string
      try {
        const submitResult = await horizonServer.submitTransaction(transaction)
        console.log("[Pi A2U] ✓ Horizon submission succeeded")
        console.log("[Pi A2U] Horizon response:", JSON.stringify(submitResult, null, 2))
        
        txidFromHorizon = submitResult.hash
        console.log("[Pi A2U] Transaction ID from Horizon:", txidFromHorizon)
        console.log("[Pi A2U] ✓ TXID extracted successfully")
      } catch (horizonError) {
        const errorMsg = horizonError instanceof Error ? horizonError.message : String(horizonError)
        console.error("[Pi A2U] ❌ STEP 3 FAILED: Horizon submission error")
        console.error("[Pi A2U] Error message:", errorMsg)
        console.error("[Pi A2U] Base fee (from Horizon):", baseFee, "stroops")
        console.error("[Pi A2U] Fee used for transaction:", usedFee, "stroops")
        
        // Log detailed error response from Horizon
        if (horizonError && typeof horizonError === "object") {
          const err = horizonError as any
          
          // Log response data if available
          if (err.response && err.response.data) {
            console.error("[Pi A2U] Horizon response.data:", JSON.stringify(err.response.data, null, 2))
          }
          
          // Log status code
          if (err.response && err.response.status) {
            console.error("[Pi A2U] HTTP Status Code:", err.response.status)
          }
          
          // Log extras (result_codes, result_xdr) - THIS IS CRITICAL FOR DEBUGGING
          if (err.response && err.response.data && err.response.data.extras) {
            console.error("[Pi A2U] Horizon extras:", JSON.stringify(err.response.data.extras, null, 2))
            
            if (err.response.data.extras.result_codes) {
              console.error("[Pi A2U] Result codes:", err.response.data.extras.result_codes)
            }
            
            if (err.response.data.extras.result_xdr) {
              console.error("[Pi A2U] Result XDR:", err.response.data.extras.result_xdr)
            }
          }
          
          // Log raw error object
          console.error("[Pi A2U] Full error object:", JSON.stringify(err, null, 2))
        }
        
        return NextResponse.json({
          error: "Failed to submit signed transaction to Horizon/Stellar network",
          step: "horizonSubmit",
          piPaymentId: a2uPayment.identifier,
          details: errorMsg,
          baseFee,
          usedFee,
          success: false,
        }, { status: 500 })
      }
      
      // Now that we have the TXID from Horizon, we can proceed to complete the A2U payment
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== STEP 4: SUBMIT TXID TO PI /COMPLETE =====")
      console.log("[Pi A2U] URL: https://api.minepi.com/v2/payments/" + a2uPayment.identifier + "/complete")
      console.log("[Pi A2U] Sending TXID to Pi /complete endpoint...")
      
      const completeResponse = await fetch(`https://api.minepi.com/v2/payments/${a2uPayment.identifier}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Key ${config.piApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          txid: txidFromHorizon,
        }),
      })
      
      console.log("[Pi A2U] Pi /complete response status:", completeResponse.status, completeResponse.statusText)
      
      if (!completeResponse.ok) {
        const completeError = await completeResponse.text()
        console.error("[Pi A2U] ❌ STEP 4 FAILED: Pi /complete returned error")
        console.error("[Pi A2U] HTTP Status:", completeResponse.status)
        console.error("[Pi A2U] Error Response:", completeError)
        
        // This is a partial failure - Stellar transaction succeeded but Pi acknowledgement failed
        console.warn("[Pi A2U] ⚠️  PARTIAL SUCCESS: Transaction on Stellar succeeded (TXID: " + txidFromHorizon + ")")
        console.warn("[Pi A2U] But Pi API /complete failed - merchant balance may not update")
        
        return NextResponse.json({
          error: "Failed to complete A2U payment on Pi backend",
          step: "piComplete",
          piPaymentId: a2uPayment.identifier,
          txid: txidFromHorizon,
          details: completeError,
          piStatus: completeResponse.status,
          partialSuccess: true,
          success: false,
        }, { status: completeResponse.status })
      }
      
      const completeData = await completeResponse.json()
      console.log("[Pi A2U] ✓ STEP 4: Pi /complete - SUCCESS")
      console.log("[Pi A2U] Complete response:", JSON.stringify(completeData, null, 2))
      
      console.log("[Pi A2U]")
      console.log("[Pi A2U] ===== ✅ A2U TRANSFER COMPLETE =====")
      console.log("[Pi A2U] All four steps completed successfully:")
      console.log("[Pi A2U]   1. createPayment: success")
      console.log("[Pi A2U]   2. build and sign transaction: success")
      console.log("[Pi A2U]   3. submit to Horizon: success (txid:", txidFromHorizon + ")")
      console.log("[Pi A2U]   4. complete on Pi backend: success")
      console.log("[Pi A2U] Merchant wallet has received funds")
      
      // Store A2U payment reference in Redis as COMPLETE
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
              status: "complete",
              step1: "createPayment_success",
              step2: "transaction_signed_success",
              step3: "horizon_submit_success",
              step4: "pi_complete_success",
              txid: txidFromHorizon,
              completedAt: new Date().toISOString(),
            })
          )
          console.log("[Pi A2U] ✓ A2U payment marked as COMPLETE in Redis")
        } catch (error) {
          console.warn("[Pi A2U] Failed to update A2U status in Redis (non-blocking):", error)
        }
      }
      
      return NextResponse.json({
        success: true,
        message: "A2U transfer completed successfully - merchant received funds",
        status: "complete",
        a2uPaymentId: a2uPayment.identifier,
        steps: {
          createPayment: "success",
          sign: "success",
          horizonSubmit: "success",
          piComplete: "success",
        },
        txid: txidFromHorizon,
        amount,
        merchantUid: merchantUid.substring(0, 10) + "...",
        timestamp: new Date().toISOString(),
      })
      
    } catch (signingError) {
      console.error("[Pi A2U] ❌ BLOCKCHAIN SIGNING/SUBMISSION FAILED")
      console.error("[Pi A2U] Error:", signingError instanceof Error ? signingError.message : String(signingError))
      console.error("[Pi A2U] Stack:", signingError instanceof Error ? signingError.stack : "no stack")
      
      return NextResponse.json({
        error: "Blockchain signing or submission failed",
        step: "blockchain_operation",
        details: signingError instanceof Error ? signingError.message : String(signingError),
        success: false,
      }, { status: 500 })
    }
  } catch (error) {
    console.error("[Pi A2U] ❌ UNEXPECTED ERROR")
    console.error("[Pi A2U] Error type:", error instanceof Error ? error.constructor.name : typeof error)
    console.error("[Pi A2U] Error message:", error instanceof Error ? error.message : String(error))
    console.error("[Pi A2U] Full error:", error)
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
