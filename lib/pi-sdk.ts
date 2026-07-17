"use client"

import { unifiedStore } from "./unified-store"
import { CoreLogger } from "./core"
import { config } from "./config"

declare global {
  interface Window {
    Pi?: {
      init: (config: { version: string; sandbox: boolean }) => Promise<void>
      authenticate: (scopes: string[], onIncompletePaymentFound: (payment: any) => void) => Promise<any>
      createPayment: (
        paymentData: {
          amount: number
          memo: string
          metadata: { paymentId: string }
        },
        callbacks: {
          onReadyForServerApproval: (paymentId: string) => void
          onReadyForServerCompletion: (paymentId: string, txid: string) => void
          onCancel: (paymentId: string) => void
          onError: (error: Error, payment?: any) => void
        },
      ) => void
    }
  }
}

let sdkLoadAttempts = 0
const MAX_SDK_LOAD_ATTEMPTS = 30
const SDK_LOAD_RETRY_DELAY = 200

if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    if (event.message?.includes("Pi") || event.filename?.includes("pi-sdk")) {
      CoreLogger.error("Pi SDK Error detected", {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
      })
    }
  })

  window.addEventListener("unhandledrejection", (event) => {
    CoreLogger.error("Unhandled promise rejection", {
      reason: event.reason?.toString(),
    })
  })
}

const waitForPiSDK = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const checkSDK = () => {
      sdkLoadAttempts++
      if (typeof window !== "undefined" && window.Pi && typeof window.Pi.init === "function") {
        resolve(true)
        return
      }
      if (sdkLoadAttempts >= MAX_SDK_LOAD_ATTEMPTS) {
        resolve(false)
        return
      }
      setTimeout(checkSDK, SDK_LOAD_RETRY_DELAY)
    }
    checkSDK()
  })
}

export const initializePiSDK = async (): Promise<{
  success: boolean
  error?: string
}> => {
  if (typeof window === "undefined") {
    return { success: false, error: "Not in browser environment" }
  }

  if (!window.Pi || typeof window.Pi.init !== "function") {
    return { success: false, error: "Pi SDK not loaded. Please open in Pi Browser." }
  }

  try {
    // sandbox: false is required — the testnet/mainnet environment is controlled
    // by Pi Developer Portal settings, not by this parameter.
    await window.Pi.init({ version: "2.0", sandbox: false })

    unifiedStore.updateWalletStatus({
      isPiSDKAvailable: true,
      isInitialized: true,
      isConnected: false,
      lastChecked: new Date(),
    })

    CoreLogger.info("Pi SDK initialized successfully")
    return { success: true }
  } catch (error) {
    CoreLogger.error("Failed to initialize Pi SDK", error)

    unifiedStore.updateWalletStatus({
      isPiSDKAvailable: true,
      isInitialized: false,
      isConnected: false,
      lastChecked: new Date(),
    })

    return {
      success: false,
      error: error instanceof Error ? error.message : "SDK initialization failed",
    }
  }
}

export const createPiPayment = async (
  amount: number,
  memo: string,
  paymentId: string,
  merchantId: string,
  merchantAddress: string,
  merchantUid: string,
  onSuccess: (txid: string) => void,
  onError: (error: string, isCancelled?: boolean) => void,
) => {
  if (typeof window === "undefined") {
    onError("Cannot create payment - not in browser", false)
    return
  }

  if (!window.Pi) {
    onError("Pi SDK not available. Please open this in Pi Browser.", false)
    return
  }

  if (!window.Pi.createPayment) {
    onError("Pi SDK incomplete - createPayment not available", false)
    return
  }

  try {
    // LOG MERCHANT DATA FOR VERIFICATION
    console.log("[v0][Pi SDK] ===== MERCHANT DATA VERIFICATION =====")
    console.log("[v0][Pi SDK] paymentId:", paymentId)
    console.log("[v0][Pi SDK] merchantId received:", merchantId, "TYPE:", typeof merchantId)
    console.log("[v0][Pi SDK] merchantAddress received:", merchantAddress, "TYPE:", typeof merchantAddress)
    console.log("[v0][Pi SDK] =============================================")

    CoreLogger.operation("Creating Pi payment", { 
      paymentId, 
      amount, 
      memo,
      merchantId,
      merchantAddress
    })

    // Track which callbacks have been invoked to prevent duplicates
    let approvalSent = false
    let completionSent = false

    const paymentData = {
      amount,
      memo: memo || "FlashPay payment",
      metadata: { 
        paymentId, 
        merchantId, 
        merchantAddress,
        merchantUid
      },
    }

    console.log("[v0][Pi SDK] Metadata being sent to Pi SDK:", JSON.stringify(paymentData.metadata))

    window.Pi.createPayment(paymentData, {
      onReadyForServerApproval: (piPaymentId: string) => {
        // Prevent duplicate approval calls
        if (approvalSent) {
          console.warn("[Pi SDK] Skipping duplicate onReadyForServerApproval call")
          return
        }
        approvalSent = true

        console.log("[v0][Pi SDK] onReadyForServerApproval CALLBACK")
        console.log("[v0][Pi SDK] Merchant data in callback - merchantId:", merchantId, "merchantAddress:", merchantAddress)

        CoreLogger.info("Payment ready for approval", { piPaymentId, paymentId, merchantId, merchantAddress })

        // Call approval endpoint - this marks payment as approved but does NOT complete it
        // The actual settlement happens in onReadyForServerCompletion
        fetch(`${config.appUrl}/api/pi/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: piPaymentId,
            amount,
            memo,
            metadata: { paymentId, merchantId, merchantAddress },
          }),
        })
          .then((response) => {
            if (response.ok) {
              CoreLogger.info("Payment approved on backend", { piPaymentId, paymentId })
              console.log("[v0][Pi SDK] ✓ Payment approved - awaiting completion")
            } else {
              CoreLogger.error("Approval failed", { status: response.status, piPaymentId })
              onError(`Approval failed: ${response.statusText}`, false)
            }
          })
          .catch((error) => {
            CoreLogger.error("Approval call failed", { error, piPaymentId })
            onError(`Approval request failed: ${error instanceof Error ? error.message : String(error)}`, false)
          })
      },

      onReadyForServerCompletion: (piPaymentId: string, txid: string) => {
        // Prevent duplicate completion calls
        if (completionSent) {
          console.warn("[Pi SDK] Skipping duplicate onReadyForServerCompletion call")
          return
        }
        completionSent = true

        console.log("[v0][Pi SDK] onReadyForServerCompletion CALLBACK")
        console.log("[v0][Pi SDK] Merchant data in callback - merchantId:", merchantId, "merchantAddress:", merchantAddress)
        console.log("[v0][Pi SDK] txid:", txid)

        CoreLogger.info("Payment ready for completion", { piPaymentId, txid, paymentId, merchantId })

        // Complete on backend and ONLY call onSuccess when status is settled_to_merchant
        // SECURITY: Send ONLY paymentId. Server retrieves all trusted data from Redis.
        fetch(`${config.appUrl}/api/pi/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ paymentId }),
        })
          .then(async (response) => {
            const completeData = await response.json()
            console.log("[v0][Pi SDK] /api/pi/complete response:", completeData)

            // CRITICAL: Only call onSuccess when settled_to_merchant
            if (completeData.status === "settled_to_merchant") {
              console.log("[v0][Pi SDK] ✅ Settlement complete - calling onSuccess")
              CoreLogger.info("Payment settled to merchant", { piPaymentId, txid, paymentId })
              onSuccess(txid)
            } else if (completeData.status === "paid_to_app") {
              console.warn("[v0][Pi SDK] ⚠ Payment received but awaiting settlement")
              onError("Payment received but settlement is pending", false)
            } else if (completeData.status === "settlement_pending") {
              console.warn("[v0][Pi SDK] ⚠ Settlement pending - blockchain signing may be needed")
              onError("Settlement awaiting blockchain confirmation", false)
            } else if (completeData.status === "settlement_failed") {
              console.error("[v0][Pi SDK] ❌ Settlement failed")
              onError("Settlement to merchant failed", false)
            } else {
              console.error("[v0][Pi SDK] ❌ Unexpected completion status:", completeData.status)
              onError("Unexpected payment status: " + completeData.status, false)
            }
          })
          .catch((error) => {
            CoreLogger.error("Failed to call /api/pi/complete", { error, piPaymentId, txid })
            onError(`Backend completion failed: ${error instanceof Error ? error.message : String(error)}`, false)
          })
      },

      onCancel: (piPaymentId: string) => {
        CoreLogger.warn("Payment cancelled by user", { piPaymentId, paymentId })
        onError("Payment was cancelled", true)
      },

      onError: (error: Error) => {
        CoreLogger.error("Payment error from Pi SDK", { error: error.message, paymentId })
        onError(error.message || "Payment failed", false)
      },
    })

    CoreLogger.info("window.Pi.createPayment() called, awaiting callbacks", { paymentId })
  } catch (error) {
    CoreLogger.error("Exception calling Pi.createPayment", { error, paymentId })
    onError(error instanceof Error ? error.message : "Failed to initiate payment", false)
  }
}

export const authenticateCustomer = async (): Promise<{
  success: boolean
  error?: string
}> => {
  console.log("[CUSTOMER-AUTH] authenticateCustomer() started")
  
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    console.error("[CUSTOMER-AUTH] Pi SDK not available")
    CoreLogger.error("Pi SDK not available for authentication")
    return { success: false, error: "Pi SDK not available. Please open in Pi Browser." }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    console.error("[CUSTOMER-AUTH] Pi SDK not initialized")
    CoreLogger.error("Pi SDK not initialized")
    return { success: false, error: "Pi SDK not initialized. Please refresh and try again." }
  }

  try {
    console.log("[CUSTOMER-AUTH] Requesting ['payments'] scope from Pi.authenticate()...")
    CoreLogger.operation("Authenticating customer with Pi SDK (payments scope)")

    const authPromise = window.Pi.authenticate(["payments"], async (payment: any) => {
      // Handle incomplete payment from Pi Network
      console.log("[CUSTOMER-AUTH] Incomplete payment callback triggered")
      CoreLogger.warn("Incomplete payment found during customer auth", payment)
      
      if (payment && payment.identifier) {
        try {
          const completeResponse = await fetch(`${config.appUrl}/api/pi/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payment),
          })
          
          if (completeResponse.ok) {
            CoreLogger.info("Successfully completed incomplete payment", { paymentId: payment.identifier })
          } else {
            CoreLogger.warn("Failed to complete incomplete payment", { 
              status: completeResponse.status,
              paymentId: payment.identifier 
            })
          }
        } catch (error) {
          CoreLogger.error("Error completing incomplete payment", { error, paymentId: payment.identifier })
        }
      }
    })

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Authentication timeout - Pi wallet did not respond after 30 seconds")),
        30000,
      )
    })

    const authResult = await Promise.race([authPromise, timeoutPromise])

    console.log("[CUSTOMER-AUTH] Pi.authenticate() returned:")
    console.log("[CUSTOMER-AUTH] Full response:", JSON.stringify(authResult, null, 2))
    console.log("[CUSTOMER-AUTH] authResult.user:", authResult?.user)
    console.log("[CUSTOMER-AUTH] authResult.user.scopes:", authResult?.user?.scopes)
    console.log("[CUSTOMER-AUTH] authResult.accessToken:", authResult?.accessToken ? "EXISTS" : "MISSING")

    if (!authResult) {
      console.error("[CUSTOMER-AUTH] authResult is null/undefined")
      return { success: false, error: "Authentication failed - no response from Pi wallet" }
    }

    if (!authResult.user) {
      console.error("[CUSTOMER-AUTH] authResult.user is missing")
      return { success: false, error: "Authentication failed - no user data from Pi wallet" }
    }

    console.log("[CUSTOMER-AUTH] ✅ Authentication response received successfully")
    
    // Check if scopes array exists and has payments scope
    const hasExplicitScopes = authResult.user.scopes && Array.isArray(authResult.user.scopes)
    const hasPaymentsScope = hasExplicitScopes ? authResult.user.scopes.includes("payments") : true // Assume granted if not explicitly listed
    
    if (hasExplicitScopes) {
      console.log("[CUSTOMER-AUTH] scopes array present:", authResult.user.scopes)
      if (!hasPaymentsScope) {
        console.warn("[CUSTOMER-AUTH] 'payments' scope not in array, but proceeding anyway")
      }
    } else {
      console.log("[CUSTOMER-AUTH] No scopes array in response - assuming 'payments' scope was granted")
    }

    // Update wallet status
    unifiedStore.updateWalletStatus({
      isConnected: true,
      isInitialized: true,
      isPiSDKAvailable: true,
      lastChecked: new Date(),
    })

    console.log("[CUSTOMER-AUTH] ✅ Authentication successful")
    return { success: true }
    
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    console.error("[CUSTOMER-AUTH] ❌ Authentication error:", error instanceof Error ? error.message : error)
    CoreLogger.error("Customer authentication error", error)
    
    return {
      success: false,
      error: isStuckPayment
        ? "A payment is stuck. Please contact support or use the emergency recovery page to clear it."
        : isTimeout
        ? "Pi wallet not responding. Please check that you're using Pi Browser and the app is approved in the Developer Portal."
        : error instanceof Error
          ? error.message
          : "Authentication failed",
    }
  }
}

export const authenticateMerchant = async (): Promise<{
  success: boolean
  username?: string
  error?: string
}> => {
  console.log("[MERCHANT-AUTH] authenticateMerchant() called")
  
  // CRITICAL: Log window context to understand where app is running
  console.log("[MERCHANT-AUTH] ===== ENVIRONMENT CONTEXT =====")
  console.log("[MERCHANT-AUTH] typeof window:", typeof window)
  console.log("[MERCHANT-AUTH] window.location.href:", typeof window !== "undefined" ? window.location.href : "N/A (no window)")
  console.log("[MERCHANT-AUTH] document.referrer:", typeof document !== "undefined" ? document.referrer : "N/A (no document)")
  console.log("[MERCHANT-AUTH] typeof window.Pi:", typeof window !== "undefined" ? typeof (window as any).Pi : "N/A")
  console.log("[MERCHANT-AUTH]")
  
  // DETECT PI BROWSER ENVIRONMENT
  const isInPiBrowser = typeof window !== "undefined" && (window as any).Pi !== undefined
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "UNKNOWN"
  const isPiBrowserUserAgent = userAgent.includes("PiBrowser") || userAgent.includes("pi-browser")
  
  console.log("[MERCHANT-AUTH] ===== PI BROWSER ENVIRONMENT CHECK =====")
  console.log("[MERCHANT-AUTH] User-Agent:", userAgent)
  console.log("[MERCHANT-AUTH] Pi SDK available:", isInPiBrowser)
  console.log("[MERCHANT-AUTH] Detected as Pi Browser:", isPiBrowserUserAgent)
  console.log("[MERCHANT-AUTH]")
  
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    console.error("[MERCHANT-AUTH] Pi SDK not available")
    CoreLogger.error("Pi SDK not available for authentication")
    return { success: false, error: "Pi SDK not available. Please open in Pi Browser." }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    console.error("[MERCHANT-AUTH] Pi SDK not initialized")
    CoreLogger.error("Pi SDK not initialized")
    return { success: false, error: "Pi SDK not initialized. Please refresh and try again." }
  }

  console.log("[MERCHANT-AUTH] Requesting scopes: ['username', 'payments', 'wallet_address']")
  
  try {
    CoreLogger.operation("Authenticating merchant with Pi SDK")

  const authPromise = window.Pi.authenticate(
  ["username", "payments", "wallet_address"],
  (payment: any) => {
  console.log("[MERCHANT-AUTH] Incomplete payment callback triggered")
  CoreLogger.warn("Incomplete payment found during auth", payment)
  }
  )
  
  // INCREASED TIMEOUT: Pi Wallet can take longer, especially on slower connections
  // 60 seconds gives Pi Wallet enough time to prompt user for permissions
  const timeoutPromise = new Promise((_, reject) => {
  setTimeout(
  () => reject(new Error("Authentication timeout - Pi wallet did not respond within 60 seconds")),
  60000,
  )
  })

    const authResult = await Promise.race([authPromise, timeoutPromise])
    
    console.log("[MERCHANT-AUTH] Pi.authenticate() returned successfully")
    console.log("[MERCHANT-AUTH] ===== FULL AUTHENTICATION RESPONSE =====")
    console.log(JSON.stringify(authResult, null, 2))
    console.log("[MERCHANT-AUTH] ===== END AUTH RESPONSE =====")
    console.log("[MERCHANT-AUTH] authResult.user:", authResult?.user)
    console.log("[MERCHANT-AUTH] authResult.user.uid:", authResult?.user?.uid)
    console.log("[MERCHANT-AUTH] authResult.accessToken:", authResult?.accessToken ? "EXISTS" : "MISSING")

    if (!authResult) {
      console.error("[MERCHANT-AUTH] authResult is null/undefined")
      return { success: false, error: "Authentication failed - no response from Pi wallet" }
    }

    if (!authResult.user) {
      console.error("[MERCHANT-AUTH] authResult.user is missing")
      return { success: false, error: "Authentication failed - no user data" }
    }

    console.log("[MERCHANT-AUTH] ✅ Authentication response received successfully")
    
    // DETECT APP CONTEXT FROM AUTHENTICATION
    console.log("[MERCHANT-AUTH]")
    console.log("[MERCHANT-AUTH] ===== APP CONTEXT FROM AUTHENTICATION =====")
    console.log("[MERCHANT-AUTH] authResult.user.app_id:", authResult.user.app_id || "NOT PROVIDED BY PI")
    console.log("[MERCHANT-AUTH] authResult.user.username:", authResult.user.username)
    console.log("[MERCHANT-AUTH] authResult.user.scopes:", JSON.stringify(authResult.user.scopes))
    console.log("[MERCHANT-AUTH]")
    console.log("[MERCHANT-AUTH] CRITICAL: The app_id above determines which app context the user is authenticated under")
    console.log("[MERCHANT-AUTH] For A2U to work, PI_API_KEY must be registered under THIS EXACT app_id")
    console.log("[MERCHANT-AUTH] If app_id differs from Developer Portal app, A2U will fail with user_not_found")
    console.log("[MERCHANT-AUTH]")
    
    // Highlight the app_id for easy identification
    if (authResult.user.app_id) {
      console.log("[MERCHANT-AUTH] ⚠️  IMPORTANT: App ID =", authResult.user.app_id)
      console.log("[MERCHANT-AUTH] Save this value and compare with:")
      console.log("[MERCHANT-AUTH]   → Pi Developer Portal app settings")
      console.log("[MERCHANT-AUTH]   → PI_API_KEY app registration")
      console.log("[MERCHANT-AUTH]")
    }
    
    console.log("[MERCHANT-AUTH] NOTE: If app_id not provided, Pi Browser is using default app context")
    console.log("[MERCHANT-AUTH] NOTE: The UID returned is scoped to this app context")
    console.log("[MERCHANT-AUTH] NOTE: A2U createPayment uses PI_API_KEY which must belong to the SAME app")
    console.log("[MERCHANT-AUTH]")
    
    // Check if scopes array exists
    const hasExplicitScopes = authResult.user.scopes && Array.isArray(authResult.user.scopes)
    
    if (hasExplicitScopes) {
      console.log("[MERCHANT-AUTH] scopes array present:", authResult.user.scopes)
    } else {
      console.log("[MERCHANT-AUTH] No scopes array in response - assuming permissions were granted")
    }
    
    // Extract UID from various possible field names
    console.log("[MERCHANT-AUTH] Extracting UID from authResult.user...")
    console.log("[MERCHANT-AUTH]   authResult.user.uid:", authResult.user.uid)
    console.log("[MERCHANT-AUTH]   authResult.user.userId:", authResult.user.userId)
    console.log("[MERCHANT-AUTH]   authResult.user.user_id:", authResult.user.user_id)
    console.log("[MERCHANT-AUTH]   authResult.user.app_uid:", authResult.user.app_uid)
    console.log("[MERCHANT-AUTH]   authResult.user.appUid:", authResult.user.appUid)
    
    const rawAuthUid = authResult.user.uid || authResult.user.userId || authResult.user.user_id || authResult.user.app_uid || authResult.user.appUid || ""
    
    if (!rawAuthUid || typeof rawAuthUid !== "string" || rawAuthUid.trim() === "") {
      console.error("[MERCHANT-AUTH] ERROR: No valid UID extracted from authResult")
      console.error("[MERCHANT-AUTH] Full authResult.user object:", JSON.stringify(authResult.user, null, 2))
      return { success: false, error: "Authentication failed - no user ID returned from Pi Network" }
    }
    
    console.log("[MERCHANT-AUTH] ✅ UID extracted successfully from Pi.authenticate()")
    console.log("[MERCHANT-AUTH] Extracted UID:", rawAuthUid.substring(0, 20) + "...")
    
    // CRITICAL: Get the accessToken for verifying uid with Pi /v2/me
    const accessToken = authResult.accessToken
    if (!accessToken || typeof accessToken !== "string" || accessToken.trim() === "") {
      console.error("[MERCHANT-AUTH] ERROR: No accessToken in authentication response")
      console.error("[MERCHANT-AUTH] accessToken value:", authResult.accessToken)
      return { success: false, error: "Authentication failed - no access token returned" }
    }
    
    console.log("[MERCHANT-AUTH] ✅ accessToken captured for verification")
    
    const username = authResult.user.username
    if (!username || typeof username !== "string" || username.trim() === "") {
      console.error("[MERCHANT-AUTH] ERROR: No valid username in authentication response")
      return { success: false, error: "Authentication failed - no username" }
    }
    
    console.log("[MERCHANT-AUTH] ✅ Username validated:", username)
    
    let walletAddress = authResult.user.wallet_address || ""
    
    console.log("[MERCHANT-AUTH] Storing merchant data and accessToken...")
    unifiedStore.completeMerchantSetup(username, walletAddress, rawAuthUid)
    
    // Store the accessToken properly with persistence and notification
    // Use updateMerchantState to ensure it's saved to storage and subscribers are notified
    unifiedStore.updateMerchantState({ accessToken })
    
    unifiedStore.updateWalletStatus({
      isConnected: true,
      isInitialized: true,
    })

    console.log("[MERCHANT-AUTH] ✅ Authentication successful. Username =", username)
    console.log("[MERCHANT-AUTH] accessToken stored. UID verification will happen during payment creation.")
    return { success: true, username }
  } catch (error) {
    console.error("[MERCHANT-AUTH] ❌ Error:", error instanceof Error ? error.message : error)
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    CoreLogger.error("Merchant authentication error", error)
    
    console.error("[MERCHANT-AUTH] ========== AUTHENTICATION ERROR DETAILS ==========")
    console.error("[MERCHANT-AUTH] Is timeout:", isTimeout)
    console.error("[MERCHANT-AUTH] Is stuck payment:", isStuckPayment)
    console.error("[MERCHANT-AUTH] Full error:", error instanceof Error ? error.message : String(error))
    console.error("[MERCHANT-AUTH] ===================================================")
    
    return {
      success: false,
      error: isStuckPayment
        ? "Stuck payment detected. Please use the emergency recovery page to clear it."
        : isTimeout
        ? "Pi wallet is not responding. Make sure you're in Pi Browser and the app is approved in Developer Portal. The system will retry automatically."
        : error instanceof Error
          ? error.message
          : "Authentication failed",
    }
  }
}

export const getSDKStatus = () => {
  const hasWindow = typeof window !== "undefined"
  const hasPiSDK = hasWindow && typeof window.Pi !== "undefined"
  const hasPiInit = hasWindow && typeof window.Pi?.init === "function"
  const hasAuthenticate = hasWindow && typeof window.Pi?.authenticate === "function"
  const walletStatus = unifiedStore.getWalletStatus()

  const userAgent = hasWindow ? navigator.userAgent : "N/A"
  const isPiBrowser =
    userAgent.includes("PiBrowser") || userAgent.includes("Pi/") || userAgent.includes("PiApp")

  return {
    environment: hasWindow ? "browser" : "server",
    isPiBrowser,
    hasPiSDK,
    hasPiInit,
    hasAuthenticate,
    walletStatus,
    userAgent,
    currentDomain: hasWindow ? window.location.hostname : "N/A",
  }
}
