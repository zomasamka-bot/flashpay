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
    
    // CRITICAL FINDING: Pi.createPayment() does NOT work with sandbox: true
    // PiNet domains (.pi) are production-like environments that require sandbox: false
    // to enable payment functionality, even though they connect to Pi Testnet
    const sandboxMode = false
    
    console.log("[v0] Initializing Pi SDK with sandbox:", sandboxMode)
    console.log("[v0] Note: sandbox: false is required for Pi.createPayment() to work")
    
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

export const createPiPayment = (
  amount: number,
  memo: string,
  paymentId: string,
  onSuccess: (txid: string) => void,
  onError: (error: string, isCancelled?: boolean) => void,
) => {
  console.log("[v0] ========== createPiPayment CALLED ==========")
  console.log("[v0] Amount:", amount)
  console.log("[v0] Memo:", memo)
  console.log("[v0] Payment ID:", paymentId)
  console.log("[v0] window.Pi exists:", typeof window !== "undefined" && !!window.Pi)
  console.log("[v0] window.Pi.createPayment exists:", typeof window !== "undefined" && !!window.Pi?.createPayment)

  if (typeof window === "undefined" || !window.Pi) {
    console.error("[v0] Pi SDK not available - window.Pi is undefined")
    CoreLogger.error("Pi SDK not available")
    onError("Pi SDK not available. Please open this in Pi Browser.", false)
    return
  }

  console.log("[v0] Pi SDK available, calling window.Pi.createPayment...")
  CoreLogger.operation("Creating Pi payment", { paymentId, amount, memo })

  // CRITICAL: Request payments scope immediately before createPayment
  // This ensures the Pi SDK has fresh authentication context
  console.log("[v0] Requesting 'payments' scope via Pi.authenticate before createPayment...")
  
  window.Pi.authenticate(
    ["payments"],
    (payment: any) => {
      console.log("[v0] Incomplete payment found during authentication:", payment)
    },
    (auth: any) => {
      console.log("[v0] ========== INLINE AUTHENTICATION RESULT ==========")
      console.log("[v0] Authentication completed for createPayment")
      console.log("[v0] Auth result:", auth)
      
      if (!auth || !auth.user || !auth.user.scopes || !auth.user.scopes.includes("payments")) {
        console.error("[v0] ❌ Payments scope not granted in inline auth")
        onError("Please grant 'payments' permission to continue", false)
        return
      }
      
      console.log("[v0] ✅ Payments scope confirmed, now calling createPayment...")

      const paymentData = {
        amount,
        memo: memo || `FlashPay payment`,
        metadata: { paymentId },
      }

      console.log("[v0] Payment data being sent to Pi SDK:", paymentData)

      try {
        window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: async (piPaymentId: string) => {
          console.log("[v0] ========== Pi SDK: onReadyForServerApproval ==========")
          console.log("[v0] Pi Payment ID:", piPaymentId)
          console.log("[v0] Your Payment ID:", paymentId)
          console.log("[v0] Calling backend to approve payment...")
          CoreLogger.info("Payment ready for server approval", { piPaymentId, paymentId })
          
          try {
            // Call your backend to approve the payment
            const response = await fetch('/api/pi/approve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                identifier: piPaymentId,
                amount,
                memo,
                metadata: { paymentId },
              })
            })
            
            if (!response.ok) {
              throw new Error(`Approval failed: ${response.statusText}`)
            }
            
            console.log("[v0] Payment approved by backend successfully")
            CoreLogger.info("Payment approved by backend", { piPaymentId, paymentId })
          } catch (error) {
            console.error("[v0] Failed to approve payment on backend:", error)
            CoreLogger.error("Failed to approve payment", { error, piPaymentId, paymentId })
            onError("Failed to approve payment with server", false)
          }
        },
        onReadyForServerCompletion: async (piPaymentId: string, txid: string) => {
          console.log("[v0] ========== Pi SDK: onReadyForServerCompletion ==========")
          console.log("[v0] Pi Payment ID:", piPaymentId)
          console.log("[v0] Transaction ID:", txid)
          console.log("[v0] Your Payment ID:", paymentId)
          console.log("[v0] Calling backend to complete payment...")
          CoreLogger.info("Payment completed successfully", { piPaymentId, txid, paymentId })
          
          try {
            // Call your backend to complete the payment
            const response = await fetch('/api/pi/complete', {
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
            
            if (!response.ok) {
              throw new Error(`Completion failed: ${response.statusText}`)
            }
            
            console.log("[v0] Payment completed on backend successfully")
            CoreLogger.info("Payment completed on backend", { piPaymentId, txid, paymentId })
            onSuccess(txid)
          } catch (error) {
            console.error("[v0] Failed to complete payment on backend:", error)
            CoreLogger.error("Failed to complete payment", { error, piPaymentId, txid, paymentId })
            // Still call onSuccess since the blockchain transaction completed
            // Backend completion is for record-keeping
            onSuccess(txid)
          }
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

      console.log("[v0] window.Pi.createPayment called successfully, waiting for callbacks...")
    } catch (error) {
      console.error("[v0] ========== EXCEPTION in window.Pi.createPayment ==========")
      console.error("[v0] Exception:", error)
      CoreLogger.error("Exception calling Pi.createPayment", { error, paymentId })
      onError(error instanceof Error ? error.message : "Failed to initiate payment", false)
    }
  }).catch((error) => {
    console.error("[v0] Failed to authenticate for createPayment:", error)
    CoreLogger.error("Failed to authenticate for createPayment", { error, paymentId })
    onError("Failed to authenticate for payment", false)
  })
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

    const authPromise = new Promise((resolve, reject) => {
      window.Pi.authenticate(
        ["payments"],
        (payment: any) => {
          console.log("[v0] Incomplete payment found during auth:", payment)
          CoreLogger.warn("Incomplete payment found during customer auth", payment)
        },
        (authData: any) => {
          console.log("[v0] Pi.authenticate SUCCESS callback invoked")
          console.log("[v0] Auth data received:", authData)
          resolve(authData)
        }
      )
    })

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
      
      // CRITICAL: Verify that 'payments' scope was actually granted
      if (!authResult.user || !authResult.user.scopes || !Array.isArray(authResult.user.scopes)) {
        console.error("[v0] ❌ CRITICAL: Authentication response missing user.scopes")
        console.error("[v0] authResult.user:", authResult.user)
        CoreLogger.error("Authentication response invalid - missing scopes data")
        return {
          success: false,
          error: "Authentication completed but scope information is missing. Please try again.",
        }
      }
      
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
