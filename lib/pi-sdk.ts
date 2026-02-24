"use client"

import { unifiedStore } from "./unified-store"
import { CoreLogger } from "./core"

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
const MAX_SDK_LOAD_ATTEMPTS = 30 // Increased to 30 attempts
const SDK_LOAD_RETRY_DELAY = 200 // Reduced to 200ms for more responsive checks

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

/**
 * Wait for Pi SDK to be available in the window object
 * Retries up to MAX_SDK_LOAD_ATTEMPTS times with delay
 */
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

/**
 * Initialize Pi SDK with retry logic and comprehensive error handling
 * Returns detailed status for UI feedback
 */
export const initializePiSDK = async (): Promise<{
  success: boolean
  error?: string
}> => {
  if (typeof window === "undefined") {
    return {
      success: false,
      error: "Not in browser environment",
    }
  }

  if (!window.Pi || typeof window.Pi.init !== "function") {
    return {
      success: false,
      error: "Pi SDK not loaded. Please open in Pi Browser.",
    }
  }

  try {
    const hostname = window.location.hostname
    console.log("[v0] Detecting environment for Pi SDK init:")
    console.log("[v0] - hostname:", hostname)
    
    // CRITICAL: Keep sandbox: false even for Testnet
    // Pi Network's implementation requires sandbox: false for the SDK to connect
    // The testnet/mainnet environment is controlled by the Pi Developer Portal settings
    // NOT by the sandbox parameter
    const sandboxMode = false
    
    console.log("[v0] Initializing Pi SDK with:")
    console.log("[v0] - version: 2.0")
    console.log("[v0] - sandbox:", sandboxMode)
    console.log("[v0] - Note: sandbox parameter does NOT control testnet vs mainnet")
    
    await window.Pi.init({
      version: "2.0",
      sandbox: sandboxMode,
    })

    unifiedStore.updateWalletStatus({
      isPiSDKAvailable: true,
      isInitialized: true,
      isConnected: false,
      lastChecked: new Date(),
    })

    CoreLogger.info("Pi SDK initialized successfully")

    return {
      success: true,
    }
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
  onSuccess: (txid: string) => void,
  onError: (error: string, isCancelled?: boolean) => void,
) => {
  console.log("[v0] ========================================")
  console.log("[v0] createPiPayment CALLED")
  console.log("[v0] ========================================")
  console.log("[v0] Timestamp:", new Date().toISOString())
  console.log("[v0] Amount:", amount)
  console.log("[v0] Memo:", memo)
  console.log("[v0] Payment ID:", paymentId)
  console.log("[v0] typeof window:", typeof window)
  console.log("[v0] window defined:", typeof window !== "undefined")

  if (typeof window === "undefined") {
    console.error("[v0] ❌ CRITICAL: window is undefined (server-side rendering?)")
    onError("Cannot create payment - not in browser", false)
    return
  }

  console.log("[v0] window.Pi exists:", !!window.Pi)
  console.log("[v0] typeof window.Pi:", typeof window.Pi)
  
  if (!window.Pi) {
    console.error("[v0] ❌ CRITICAL: window.Pi is undefined")
    console.error("[v0] This means Pi SDK is not loaded")
    console.error("[v0] User agent:", navigator.userAgent)
    console.error("[v0] Current domain:", window.location.hostname)
    onError("Pi SDK not available. Please open this in Pi Browser.", false)
    return
  }

  console.log("[v0] ✅ window.Pi exists")
  console.log("[v0] window.Pi.createPayment exists:", !!window.Pi.createPayment)
  console.log("[v0] typeof window.Pi.createPayment:", typeof window.Pi.createPayment)
  
  if (!window.Pi.createPayment) {
    console.error("[v0] ❌ CRITICAL: window.Pi.createPayment is undefined")
    console.error("[v0] Pi SDK loaded but createPayment method missing")
    onError("Pi SDK incomplete - createPayment not available", false)
    return
  }

  console.log("[v0] ========== READY TO CREATE PAYMENT ==========")
  console.log("[v0] Current domain:", window.location.hostname)
  console.log("[v0] User agent:", navigator.userAgent)
  
  try {
    console.log("[v0] ⚡ About to call window.Pi.createPayment NOW...")
    CoreLogger.operation("Creating Pi payment", { paymentId, amount, memo })

    // Get backend URL from environment
    const backendUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin
    console.log("[v0] Backend URL for Pi webhooks:", backendUrl)
    
    const paymentData = {
      amount,
      memo: memo || `FlashPay payment`,
      metadata: { paymentId },
    }

    console.log("[v0] Payment data being sent to Pi SDK:", paymentData)
    console.log("[v0] Platform API URL:", `${backendUrl}/api/pi`)

    console.log("[v0] ⚡⚡⚡ CALLING window.Pi.createPayment() NOW ⚡⚡⚡")
    console.log("[v0] If you don't see callbacks below, createPayment failed silently")
    
    window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: (piPaymentId: string) => {
          console.log("[v0] ✅✅✅ onReadyForServerApproval CALLBACK FIRED ✅✅✅")
          console.log("[v0] ========== Pi SDK: onReadyForServerApproval ==========")
          console.log("[v0] Pi Payment ID:", piPaymentId)
          console.log("[v0] Your Payment ID:", paymentId)
          console.log("[v0] ⚡ Calling /api/pi/approve immediately to approve payment")
          CoreLogger.info("Payment ready - approving now", { piPaymentId, paymentId })
          
          // CRITICAL: Approve immediately - don't wait for async operations
          // Fire and forget to ensure instant approval
          fetch('/api/pi/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identifier: piPaymentId,
              amount,
              memo,
              metadata: { paymentId },
            })
          })
            .then(response => {
              if (response.ok) {
                console.log("[v0] ✅ Payment approved successfully")
                CoreLogger.info("Payment approved by backend", { piPaymentId, paymentId })
              } else {
                console.error("[v0] ❌ Approval failed:", response.status)
              }
            })
            .catch(error => {
              console.error("[v0] ❌ Approval call failed:", error)
            })
          
          console.log("[v0] Approval request sent in background")
        },
        onReadyForServerCompletion: (piPaymentId: string, txid: string) => {
          console.log("[v0] ========== Pi SDK: onReadyForServerCompletion ==========")
          console.log("[v0] Pi Payment ID:", piPaymentId)
          console.log("[v0] Transaction ID:", txid)
          console.log("[v0] Your Payment ID:", paymentId)
          console.log("[v0] ⚡ IMMEDIATE callback - calling backend WITHOUT await")
          CoreLogger.info("Payment completed successfully", { piPaymentId, txid, paymentId })
          
          // CRITICAL: Call onSuccess IMMEDIATELY - don't wait for backend
          // The Pi SDK requires immediate response to prevent timeout
          onSuccess(txid)
          console.log("[v0] ✅ onSuccess called immediately")
          
          // Call backend in background (fire and forget)
          // This prevents the 60-second timeout
          fetch('/api/pi/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identifier: piPaymentId,
              amount,
              memo,
              metadata: { paymentId },
              transaction: { txid, verified: true }
            })
          })
            .then(response => {
              if (response.ok) {
                console.log("[v0] ✅ Backend /api/pi/complete succeeded")
                CoreLogger.info("Payment completed on backend", { piPaymentId, txid, paymentId })
              } else {
                console.error("[v0] ❌ Backend /api/pi/complete failed:", response.statusText)
              }
            })
            .catch(error => {
              console.error("[v0] ❌ Failed to call /api/pi/complete:", error)
              CoreLogger.error("Failed to complete payment on backend", { error, piPaymentId, txid, paymentId })
            })
          
          console.log("[v0] Background /api/pi/complete request sent, callback returning immediately")
        },
        onCancel: (piPaymentId: string) => {
          console.log("[v0] ========== Pi SDK: onCancel ==========")
          console.log("[v0] Pi Payment ID:", piPaymentId)
          console.log("[v0] User cancelled the payment")
          CoreLogger.warn("Payment cancelled by user", { piPaymentId, paymentId })
          onError("Payment was cancelled", true)
        },
        onError: (error: Error) => {
          console.log("[v0] ========== Pi SDK: onError ==========")
          console.log("[v0] Error message:", error.message)
          console.log("[v0] Error object:", error)
          CoreLogger.error("Payment error", { error: error.message, paymentId })
          onError(error.message || "Payment failed", false)
        },
      })

      console.log("[v0] ========================================")
      console.log("[v0] ✅ window.Pi.createPayment() EXECUTED")
      console.log("[v0] ========================================")
      console.log("[v0] Now waiting for Pi SDK callbacks...")
      console.log("[v0] - onReadyForServerApproval should fire when user approves")
      console.log("[v0] - onReadyForServerCompletion should fire after blockchain confirm")
      console.log("[v0] - onCancel fires if user cancels")
      console.log("[v0] - onError fires if something fails")
      console.log("[v0] If Pi approval dialog doesn't show, check:")
      console.log("[v0]   1. App is approved in Pi Developer Portal")
      console.log("[v0]   2. Payment scope is enabled")
      console.log("[v0]   3. User is authenticated with payments scope")
      console.log("[v0] ========================================")
  } catch (error) {
    console.error("[v0] ========================================")
    console.error("[v0] ❌❌❌ EXCEPTION in createPiPayment ❌❌❌")
    console.error("[v0] ========================================")
    console.error("[v0] Error type:", error?.constructor?.name)
    console.error("[v0] Error message:", error instanceof Error ? error.message : String(error))
    console.error("[v0] Error stack:", error instanceof Error ? error.stack : "N/A")
    console.error("[v0] Full error object:", error)
    console.error("[v0] ========================================")
    CoreLogger.error("Exception calling Pi.createPayment", { error, paymentId })
    onError(error instanceof Error ? error.message : "Failed to initiate payment", false)
  }
}

/**
 * Authenticate customer for payment
 * Only requests "payments" scope - customers don't need to share username
 */
export const authenticateCustomer = async (): Promise<{
  success: boolean
  error?: string
}> => {
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    CoreLogger.error("Pi SDK not available for authentication")
    return {
      success: false,
      error: "Pi SDK not available. Please open in Pi Browser.",
    }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    CoreLogger.error("Pi SDK not initialized")
    return {
      success: false,
      error: "Pi SDK not initialized. Please refresh and try again.",
    }
  }

  try {
    CoreLogger.operation("Authenticating customer with Pi SDK (payments scope)")
    console.log("[v0] Calling Pi.authenticate with scopes: [\"payments\"]")

    const authPromise = window.Pi.authenticate(
      ["payments"],
      (payment: any) => {
        console.log("[v0] Incomplete payment found during auth:", payment)
        CoreLogger.warn("Incomplete payment found during customer auth", payment)
      }
    )

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        console.error("[v0] Authentication timeout after 30 seconds")
        reject(new Error("Authentication timeout - Pi wallet did not respond after 30 seconds"))
      }, 30000)
    })

    console.log("[v0] Waiting for authentication popup response...")
    const authResult = await Promise.race([authPromise, timeoutPromise])
    console.log("[v0] Authentication completed, processing result...")

    if (authResult) {
      console.log("[v0] ========== AUTHENTICATION RESULT ==========")
      console.log("[v0] Full authResult object:", authResult)
      console.log("[v0] authResult type:", typeof authResult)
      console.log("[v0] authResult.user:", authResult?.user)
      console.log("[v0] authResult.accessToken:", authResult?.accessToken ? "present" : "missing")
      
      // Check if we have user.scopes in the expected format
      const hasUserScopes = authResult.user && authResult.user.scopes && Array.isArray(authResult.user.scopes)
      console.log("[v0] Has user.scopes:", hasUserScopes)
      
      if (hasUserScopes) {
        // Standard path: scopes are present
        console.log("[v0] Scopes granted:", authResult.user.scopes)
        const hasPaymentsScope = authResult.user.scopes.includes("payments")
        console.log("[v0] Has 'payments' scope:", hasPaymentsScope)
        
        if (!hasPaymentsScope) {
          console.error("[v0] ❌ CRITICAL: 'payments' scope was NOT granted!")
          CoreLogger.error("Payments scope not granted by user")
          return {
            success: false,
            error: "The 'payments' scope is required. Please grant permission to make payments.",
          }
        }
        
        console.log("[v0] ✅ Authentication successful with 'payments' scope")
        CoreLogger.info("Customer authenticated successfully for payments")
      } else {
        // Fallback path: scopes are missing but authentication completed
        // This can happen in some Pi SDK versions or environments
        console.warn("[v0] ⚠️ WARNING: user.scopes not present in expected format")
        console.warn("[v0] However, authentication completed without error")
        console.warn("[v0] Assuming 'payments' scope was granted since user approved")
        console.warn("[v0] authResult.user structure:", JSON.stringify(authResult.user))
        
        // If authentication completed and we have a user object with accessToken,
        // we can assume the requested scopes were granted
        if (authResult.accessToken && authResult.user) {
          console.log("[v0] ✅ Authentication completed with accessToken - assuming success")
          CoreLogger.warn("Authentication completed without explicit scope data - assuming payments scope granted")
        } else {
          console.error("[v0] ❌ Authentication completed but missing critical data")
          CoreLogger.error("Authentication response invalid - missing scopes and accessToken")
          return {
            success: false,
            error: "Authentication completed but scope information is missing. Please try again.",
          }
        }
      }

      // Explicitly update wallet connection status
      console.log("[v0] Updating wallet status: isConnected=true, isInitialized=true")
      unifiedStore.updateWalletStatus({
        isConnected: true,
        isInitialized: true,
        isPiSDKAvailable: true,
        lastChecked: new Date(),
      })

      // Verify the update was persisted
      const verifyStatus = unifiedStore.getWalletStatus()
      console.log("[v0] Wallet status after update:", verifyStatus)
      
      if (!verifyStatus.isConnected) {
        console.error("[v0] ❌ WARNING: Wallet status update did not persist!")
      }

      return {
        success: true,
      }
    }

    CoreLogger.error("Customer authentication failed - no auth result")
    return {
      success: false,
      error: "Authentication failed - please try again",
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")

    CoreLogger.error("Customer authentication error", error)

    return {
      success: false,
      error: isTimeout
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
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    CoreLogger.error("Pi SDK not available for authentication")
    return {
      success: false,
      error: "Pi SDK not available. Please open in Pi Browser.",
    }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    CoreLogger.error("Pi SDK not initialized")
    return {
      success: false,
      error: "Pi SDK not initialized. Please refresh and try again.",
    }
  }

  try {
    CoreLogger.operation("Authenticating merchant with Pi SDK")

    const authPromise = window.Pi.authenticate(["username", "payments"], (payment: any) => {
      CoreLogger.warn("Incomplete payment found during auth", payment)
    })

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Authentication timeout - Pi wallet did not respond after 30 seconds")), 30000)
    })

    const authResult = await Promise.race([authPromise, timeoutPromise])

    if (authResult && authResult.user && authResult.user.username) {
      CoreLogger.info("Merchant authenticated successfully", {
        username: authResult.user.username,
      })

      unifiedStore.completeMerchantSetup(authResult.user.username)

      unifiedStore.updateWalletStatus({
        isConnected: true,
        isInitialized: true,
      })

      return {
        success: true,
        username: authResult.user.username,
      }
    }

    CoreLogger.error("Authentication failed - no user data")
    return {
      success: false,
      error: "Authentication failed - no user data received",
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")

    CoreLogger.error("Merchant authentication error", error)

    return {
      success: false,
      error: isTimeout
        ? "Pi wallet not responding. Check: 1) App is approved in Developer Portal, 2) Scopes (username, payments) are enabled, 3) App Domain is set to flashpay.pi"
        : error instanceof Error
          ? error.message
          : "Authentication failed",
    }
  }
}

/**
 * Get current SDK status for debugging
 */
export const getSDKStatus = () => {
  const hasWindow = typeof window !== "undefined"
  const hasPiSDK = hasWindow && typeof window.Pi !== "undefined"
  const hasPiInit = hasWindow && typeof window.Pi?.init === "function"
  const hasAuthenticate = hasWindow && typeof window.Pi?.authenticate === "function"
  const walletStatus = unifiedStore.getWalletStatus()

  const userAgent = hasWindow ? navigator.userAgent : "N/A"
  const isPiBrowser = userAgent.includes("PiBrowser") || userAgent.includes("Pi/") || userAgent.includes("PiApp")

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
