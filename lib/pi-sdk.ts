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
        merchantAddress // Ensure merchantAddress is in metadata
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
              CoreLogger.info("Payment approved by backend", { piPaymentId, paymentId })
            } else {
              CoreLogger.error("Approval failed", { status: response.status, piPaymentId })
            }
          })
          .catch((error) => {
            CoreLogger.error("Approval call failed", { error, piPaymentId })
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

        // Call onSuccess immediately — Pi SDK requires fast response to prevent timeout
        onSuccess(txid)

        // Complete on backend in background
        fetch(`${config.appUrl}/api/pi/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier: piPaymentId,
            amount,
            memo,
            metadata: { paymentId, merchantId, merchantAddress },
            transaction: { txid, verified: true },
          }),
        })
          .then((response) => {
            if (response.ok) {
              CoreLogger.info("Payment completed on backend", { piPaymentId, txid, paymentId })
            } else {
              CoreLogger.error("Backend completion failed", { status: response.statusText })
            }
          })
          .catch((error) => {
            CoreLogger.error("Failed to call /api/pi/complete", { error, piPaymentId, txid })
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
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    CoreLogger.error("Pi SDK not available for authentication")
    return { success: false, error: "Pi SDK not available. Please open in Pi Browser." }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    CoreLogger.error("Pi SDK not initialized")
    return { success: false, error: "Pi SDK not initialized. Please refresh and try again." }
  }

  try {
    CoreLogger.operation("Authenticating customer with Pi SDK (payments scope)")

    const authPromise = window.Pi.authenticate(["payments"], async (payment: any) => {
      // Handle incomplete payment from Pi Network
      CoreLogger.warn("Incomplete payment found during customer auth", payment)
      
      if (payment && payment.identifier) {
        try {
          // Try to complete the stuck payment automatically
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

    if (authResult) {
      const hasUserScopes =
        authResult.user && authResult.user.scopes && Array.isArray(authResult.user.scopes)

      if (hasUserScopes) {
        const hasPaymentsScope = authResult.user.scopes.includes("payments")
        if (!hasPaymentsScope) {
          CoreLogger.error("Payments scope not granted by user")
          return {
            success: false,
            error: "The 'payments' scope is required. Please grant permission to make payments.",
          }
        }
        CoreLogger.info("Customer authenticated successfully with payments scope")
      } else if (authResult.accessToken && authResult.user) {
        CoreLogger.warn("Authentication completed without explicit scope data — assuming payments scope granted")
      } else {
        CoreLogger.error("Authentication response invalid - missing scopes and accessToken")
        return {
          success: false,
          error: "Authentication completed but scope information is missing. Please try again.",
        }
      }

      unifiedStore.updateWalletStatus({
        isConnected: true,
        isInitialized: true,
        isPiSDKAvailable: true,
        lastChecked: new Date(),
      })

      return { success: true }
    }

    CoreLogger.error("Customer authentication failed - no auth result")
    return { success: false, error: "Authentication failed - please try again" }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    CoreLogger.error("Customer authentication error", error)
    
    // For stuck payment errors, try to clear it via emergency endpoint and then retry
    if (isStuckPayment) {
      CoreLogger.warn("Detected stuck payment error - attempting emergency clear...")
      try {
        const clearResponse = await fetch(`${config.appUrl}/api/emergency/clear-stuck-payment`, {
          method: "POST",
        })
        
        if (clearResponse.ok) {
          CoreLogger.info("Emergency clear succeeded - payment should be unblocked")
          return {
            success: false,
            error: "A stuck payment was detected and cleared. Please try again."
          }
        }
      } catch (clearError) {
        CoreLogger.error("Failed to clear stuck payment via emergency endpoint", clearError)
      }
    }
    
    return {
      success: false,
      error: isStuckPayment
        ? "Stuck payment detected. Please try again - the system is attempting to clear it."
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
  if (typeof window === "undefined" || !window.Pi || typeof window.Pi.authenticate !== "function") {
    CoreLogger.error("Pi SDK not available for authentication")
    return { success: false, error: "Pi SDK not available. Please open in Pi Browser." }
  }

  const walletStatus = unifiedStore.getWalletStatus()
  if (!walletStatus.isInitialized) {
    CoreLogger.error("Pi SDK not initialized")
    return { success: false, error: "Pi SDK not initialized. Please refresh and try again." }
  }

  try {
    CoreLogger.operation("Authenticating merchant with Pi SDK")

    const authPromise = window.Pi.authenticate(
      ["username", "payments", "wallet_address"],
      (payment: any) => {
        CoreLogger.warn("Incomplete payment found during auth", payment)
      }
    )

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Authentication timeout - Pi wallet did not respond after 30 seconds")),
        30000,
      )
    })

    const authResult = await Promise.race([authPromise, timeoutPromise])

    if (authResult && authResult.user && authResult.user.username) {
      const username = authResult.user.username
      
      // DEBUG: Log COMPLETE authResult structure to see what Pi actually returns
      console.log("[v0] === COMPLETE Pi.authenticate() RESPONSE ===")
      console.log("[v0] Full authResult object:", JSON.stringify(authResult, null, 2))
      console.log("[v0]")
      console.log("[v0] authResult keys:", Object.keys(authResult))
      console.log("[v0] authResult.user keys:", Object.keys(authResult.user))
      console.log("[v0]")
      
      // Try multiple possible UID locations
      const uid = authResult.user.uid || authResult.user.userId || authResult.user.user_id || ""
      const appId = authResult.user.app_id || authResult.user.appId || ""
      const appUid = authResult.user.app_uid || authResult.user.appUid || ""
      
      console.log("[v0] Checking possible UID locations:")
      console.log("[v0]   authResult.user.uid:", authResult.user.uid)
      console.log("[v0]   authResult.user.userId:", authResult.user.userId)
      console.log("[v0]   authResult.user.user_id:", authResult.user.user_id)
      console.log("[v0]   authResult.user.app_id:", authResult.user.app_id)
      console.log("[v0]   authResult.user.appId:", authResult.user.appId)
      console.log("[v0]   authResult.user.app_uid:", authResult.user.app_uid)
      console.log("[v0]   authResult.user.appUid:", authResult.user.appUid)
      console.log("[v0]")
      console.log("[v0] Using UID:", uid || "(EMPTY - CRITICAL)")
      console.log("[v0] =======================================")
      
      // CRITICAL CHECK: If uid is empty, log ALL properties of authResult.user
      if (!uid && !appUid && !appId) {
        console.error("[v0] ❌ CRITICAL: No UID found in any expected location!")
        console.error("[v0] authResult.user properties:")
        Object.entries(authResult.user).forEach(([key, value]) => {
          console.error(`[v0]   ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
        })
      }
      
      // Extract wallet_address from Pi SDK response
      let walletAddress = authResult.user.wallet_address || ""
      
      // If wallet_address is not available from authenticate response,
      // try to get it from window.Pi object after successful authentication
      if (!walletAddress && typeof window !== "undefined" && window.Pi) {
        try {
          walletAddress = window.Pi.wallet?.address || ""
        } catch (e) {
          // Silently fail - wallet address will remain empty
        }
      }
      
      // Use uid if available, otherwise try appUid, otherwise empty
      const finalUid = uid || appUid || ""
      console.log("[v0] Final UID being stored:", finalUid || "(EMPTY - THIS IS THE PROBLEM)")
      
      // Store EXACT uid without any transformation
      unifiedStore.completeMerchantSetup(username, walletAddress, finalUid)

      unifiedStore.updateWalletStatus({
        isConnected: true,
        isInitialized: true,
      })

      return { success: true, username }
    }

    CoreLogger.error("Authentication failed - no user data")
    return { success: false, error: "Authentication failed - no user data received" }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    CoreLogger.error("Merchant authentication error", error)
    
    // For stuck payment errors, try to clear it via emergency endpoint
    if (isStuckPayment) {
      CoreLogger.warn("Detected stuck payment error in merchant auth - attempting emergency clear...")
      try {
        const clearResponse = await fetch(`${config.appUrl}/api/emergency/clear-stuck-payment`, {
          method: "POST",
        })
        
        if (clearResponse.ok) {
          CoreLogger.info("Emergency clear succeeded - payment should be unblocked")
          return {
            success: false,
            error: "A stuck payment was detected and cleared. Please try again."
          }
        }
      } catch (clearError) {
        CoreLogger.error("Failed to clear stuck payment via emergency endpoint", clearError)
      }
    }
    
    return {
      success: false,
      error: isStuckPayment
        ? "Stuck payment detected. Please try again - the system is attempting to clear it."
        : isTimeout
        ? "Pi wallet not responding. Check: 1) App is approved in Developer Portal, 2) Scopes (username, payments) are enabled, 3) App Domain is set to flashpay.pi"
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
