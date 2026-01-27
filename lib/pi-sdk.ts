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
    await window.Pi.init({
      version: "2.0",
      sandbox: true, // MUST be true for Pi Testnet - false is for Mainnet only
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

  if (typeof window === "undefined" || !window.Pi) {
    console.error("[v0] Pi SDK not available - window.Pi is undefined")
    CoreLogger.error("Pi SDK not available")
    onError("Pi SDK not available. Please open this in Pi Browser.", false)
    return
  }

  console.log("[v0] Pi SDK available, calling window.Pi.createPayment...")
  CoreLogger.operation("Creating Pi payment", { paymentId, amount, memo })

  const paymentData = {
    amount,
    memo: memo || `FlashPay payment`,
    metadata: { paymentId },
  }

  console.log("[v0] Payment data being sent to Pi SDK:", paymentData)

  window.Pi.createPayment(paymentData, {
    onReadyForServerApproval: async (piPaymentId: string) => {
      console.log("[v0] ========== Pi SDK: onReadyForServerApproval ==========")
      console.log("[v0] Pi Payment ID:", piPaymentId)
      console.log("[v0] Your Payment ID:", paymentId)
      console.log("[v0] Calling /api/pi/approve endpoint...")
      CoreLogger.info("Payment ready for server approval", { piPaymentId, paymentId })

      // Call our own approve endpoint since we're self-hosting
      try {
        const approveResponse = await fetch('/api/pi/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: piPaymentId,
            user_uid: 'customer',
            amount: amount,
            memo: memo,
            metadata: { paymentId },
            from_address: 'pending',
            to_address: 'pending',
            direction: 'inbound',
            network: 'Pi Testnet',
            created_at: new Date().toISOString(),
            status: {
              developer_approved: false,
              transaction_verified: false,
              developer_completed: false,
              cancelled: false,
              user_cancelled: false,
            }
          })
        })
        
        const approveResult = await approveResponse.json()
        console.log("[v0] Approve endpoint response:", approveResult)
        
        if (!approveResponse.ok) {
          console.error("[v0] Approve endpoint failed:", approveResult)
        }
      } catch (error) {
        console.error("[v0] Error calling approve endpoint:", error)
      }
    },
    onReadyForServerCompletion: async (piPaymentId: string, txid: string) => {
      console.log("[v0] ========== Pi SDK: onReadyForServerCompletion ==========")
      console.log("[v0] Pi Payment ID:", piPaymentId)
      console.log("[v0] Transaction ID:", txid)
      console.log("[v0] Your Payment ID:", paymentId)
      console.log("[v0] Calling /api/pi/complete endpoint...")
      CoreLogger.info("Payment completed successfully", { piPaymentId, txid, paymentId })

      // Call our own complete endpoint since we're self-hosting
      try {
        const completeResponse = await fetch('/api/pi/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            identifier: piPaymentId,
            user_uid: 'customer',
            amount: amount,
            memo: memo,
            metadata: { paymentId },
            from_address: 'customer_address',
            to_address: 'merchant_address',
            direction: 'inbound',
            network: 'Pi Testnet',
            created_at: new Date().toISOString(),
            transaction: {
              txid: txid,
              verified: true,
              _link: `https://blockexplorer.minepi.com/tx/${txid}`
            },
            status: {
              developer_approved: true,
              transaction_verified: true,
              developer_completed: false,
              cancelled: false,
              user_cancelled: false,
            }
          })
        })
        
        const completeResult = await completeResponse.json()
        console.log("[v0] Complete endpoint response:", completeResult)
        
        if (!completeResponse.ok) {
          console.error("[v0] Complete endpoint failed:", completeResult)
        }
      } catch (error) {
        console.error("[v0] Error calling complete endpoint:", error)
      }

      // Call success callback after updating backend
      onSuccess(txid)
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

  console.log("[v0] window.Pi.createPayment called - waiting for Pi Network callbacks...")
  console.log("[v0] If callbacks don't fire, check: 1) sandbox: true for Testnet, 2) Pi Browser environment, 3) User approves in wallet")
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
