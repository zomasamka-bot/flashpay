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
  onProcessing?: (status: "paid_to_app" | "settlement_pending") => void,
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


    window.Pi.createPayment(paymentData, {
      onReadyForServerApproval: (piPaymentId: string) => {
        // Prevent duplicate approval calls
        if (approvalSent) {
          return
        }
        approvalSent = true


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
          return
        }
        completionSent = true


        CoreLogger.info("Payment ready for completion", { piPaymentId, txid, paymentId, merchantId })

        // Complete on backend and ONLY call onSuccess when status is settled_to_merchant
        // SECURITY: Send ONLY piPaymentId + txid (verified by Pi Wallet signature)
        // Server derives paymentId from canonical payment metadata
        fetch(`${config.appUrl}/api/pi/complete`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ piPaymentId, txid }),
        })
          .then(async (response) => {
            const completeData = await response.json()

            // CRITICAL: Processing states (paid_to_app, settlement_pending) are NOT errors
            // They indicate the payment is in progress and will eventually settle
            // Do NOT route them to error callback - client should continue polling
            if (completeData.status === "paid_to_app" || completeData.status === "settlement_pending" || completeData.status === "refund_pending") {
              CoreLogger.info("Payment in processing state", { piPaymentId, txid, paymentId, status: completeData.status })
              // Processing states should be handled by polling or dedicated processing callback
              // Do NOT call onSuccess or onError - let client continue polling or use recovery flow
              onProcessing?.(completeData.status)
              return
            }

            // ONLY call onSuccess when settled_to_merchant
            // Pass the verified U2A txid from Pi Wallet callback to component
            if (completeData.success === true && completeData.status === "settled_to_merchant") {
              CoreLogger.info("Payment settled to merchant", { piPaymentId, txid, paymentId })
              // txid here is the verified transaction ID from Pi Wallet (U2A success)
              onSuccess(txid)
            } else if (completeData.status === "settlement_failed") {
              CoreLogger.error("Settlement failed - blocking automated retry", { piPaymentId, txid, paymentId, a2uTxid: completeData.a2uTxid, horizonSuccessFlag: completeData.horizonSuccessFlag })
              // settlement_failed with a2uTxid and horizonSuccessFlag = terminal state requiring manual review
              onError("Settlement to merchant failed - requires manual review", false)
            } else {
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
  accessToken?: string
  uid?: string
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
    CoreLogger.operation("Authenticating customer with Pi SDK (username + payments + wallet_address scopes)")

    const authPromise = window.Pi.authenticate(["username","payments","wallet_address"], async (payment: any) => {
      // Handle incomplete payment from Pi Network
      
      // Only attempt completion if both piPaymentId and txid exist
      const piPaymentId = payment?.identifier
      const txid = payment?.transaction?.txid
      
      if (!piPaymentId || !txid) {
        CoreLogger.warn("Incomplete payment missing required fields", {
          hasIdentifier: !!piPaymentId,
          hasTransaction: !!payment?.transaction,
          hasTransactionId: !!txid,
        })
        return
      }
      
      try {
        const completeResponse = await fetch(`${config.appUrl}/api/pi/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ piPaymentId, txid }),
        })
        
        if (completeResponse.ok) {
          CoreLogger.info("Successfully completed incomplete payment", { piPaymentId, txid })
        } else {
          CoreLogger.warn("Failed to complete incomplete payment", { 
            status: completeResponse.status,
            piPaymentId,
            txid,
          })
        }
      } catch (error) {
        CoreLogger.error("Error completing incomplete payment", { error, piPaymentId, txid })
      }
    })

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Authentication timeout - Pi wallet did not respond after 30 seconds")),
        30000,
      )
    })

    const authResult = await Promise.race([authPromise, timeoutPromise])


    if (!authResult) {
      return { success: false, error: "Authentication failed - no response from Pi wallet" }
    }

    if (!authResult.user) {
      return { success: false, error: "Authentication failed - no user data from Pi wallet" }
    }

    
    // Check if scopes array exists and has payments scope
    const hasExplicitScopes = authResult.user.scopes && Array.isArray(authResult.user.scopes)
    const hasPaymentsScope = hasExplicitScopes ? authResult.user.scopes.includes("payments") : true // Assume granted if not explicitly listed
    
    if (hasExplicitScopes) {
      if (!hasPaymentsScope) {
      }
    } else {
    }

    // Update wallet status
    unifiedStore.updateWalletStatus({
      isConnected: true,
      isInitialized: true,
      isPiSDKAvailable: true,
      lastChecked: new Date(),
    })

    const accessToken = typeof authResult.accessToken === "string" ? authResult.accessToken.trim() : ""
    const uid = typeof authResult.user.uid === "string" ? authResult.user.uid.trim() : ""
    const username = typeof authResult.user.username === "string" ? authResult.user.username.trim() : ""

    return {
      success: true,
      accessToken: accessToken || undefined,
      uid: uid || undefined,
      username: username || undefined,
    }
    
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    CoreLogger.error("Customer authentication error", error)
    
    return {
      success: false,
      error: isStuckPayment
        ? "A payment is stuck. Manual review is required; do not clear or retry it automatically."
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
  
  // CRITICAL: Log window context to understand where app is running
  
  // DETECT PI BROWSER ENVIRONMENT
  const isInPiBrowser = typeof window !== "undefined" && (window as any).Pi !== undefined
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "UNKNOWN"
  const isPiBrowserUserAgent = userAgent.includes("PiBrowser") || userAgent.includes("pi-browser")
  
  
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
      async (payment: any) => {
    // Handle incomplete payment from Pi Network
    
    // Only attempt completion if both piPaymentId and txid exist
    const piPaymentId = payment?.identifier
    const txid = payment?.transaction?.txid
    
    if (!piPaymentId || !txid) {
      CoreLogger.warn("Incomplete payment missing required fields during merchant auth", {
        hasIdentifier: !!piPaymentId,
        hasTransaction: !!payment?.transaction,
        hasTransactionId: !!txid,
      })
      return
    }
    
    try {
      const completeResponse = await fetch(`${config.appUrl}/api/pi/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ piPaymentId, txid }),
      })
      
      if (completeResponse.ok) {
        CoreLogger.info("Successfully completed incomplete payment during merchant auth", { piPaymentId, txid })
      } else {
        CoreLogger.warn("Failed to complete incomplete payment during merchant auth", { 
          status: completeResponse.status,
          piPaymentId,
          txid,
        })
      }
    } catch (error) {
      CoreLogger.error("Error completing incomplete payment during merchant auth", { error, piPaymentId, txid })
    }
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
    

    if (!authResult) {
      return { success: false, error: "Authentication failed - no response from Pi wallet" }
    }

    if (!authResult.user) {
      return { success: false, error: "Authentication failed - no user data" }
    }

    
    // DETECT APP CONTEXT FROM AUTHENTICATION
    
    // Highlight the app_id for easy identification
    if (authResult.user.app_id) {
    }
    
    
    // Check if scopes array exists
    const hasExplicitScopes = authResult.user.scopes && Array.isArray(authResult.user.scopes)
    
    if (hasExplicitScopes) {
    } else {
    }
    
    // Extract UID from various possible field names
    
    const rawAuthUid = authResult.user.uid || authResult.user.userId || authResult.user.user_id || authResult.user.app_uid || authResult.user.appUid || ""
    
    if (!rawAuthUid || typeof rawAuthUid !== "string" || rawAuthUid.trim() === "") {
      return { success: false, error: "Authentication failed - no user ID returned from Pi Network" }
    }
    
    
    // CRITICAL: Get the accessToken for verifying uid with Pi /v2/me
    const accessToken = authResult.accessToken
    if (!accessToken || typeof accessToken !== "string" || accessToken.trim() === "") {
      return { success: false, error: "Authentication failed - no access token returned" }
    }
    
    
    const username = authResult.user.username
    if (!username || typeof username !== "string" || username.trim() === "") {
      return { success: false, error: "Authentication failed - no username" }
    }
    
    
    let walletAddress = authResult.user.wallet_address || ""
    
    unifiedStore.completeMerchantSetup(username, walletAddress, rawAuthUid)
    
    // Store the accessToken properly with persistence and notification
    // Use updateMerchantState to ensure it's saved to storage and subscribers are notified
    unifiedStore.updateMerchantState({ accessToken })
    
    unifiedStore.updateWalletStatus({
      isConnected: true,
      isInitialized: true,
    })

    return { success: true, username }
  } catch (error) {
    const isTimeout = error instanceof Error && error.message.includes("timeout")
    const isStuckPayment = error instanceof Error && (
      error.message.includes("pending payment") ||
      error.message.includes("A pending payment") ||
      error.message.includes("incomplete payment") ||
      error.message.includes("payment.*needs.*handled")
    )
    
    CoreLogger.error("Merchant authentication error", error)
    
    
    return {
      success: false,
      error: isStuckPayment
        ? "A payment is stuck. Manual review is required; do not clear or retry it automatically."
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

export const authenticateCustomerForRefundRead = async (): Promise<
  | { success: true; accessToken: string; uid: string }
  | { success: false; error: string }
> => {
  if (typeof window === "undefined") return { success: false, error: "Not in browser environment" }
  if (!window.Pi || typeof window.Pi.authenticate !== "function") {
    return { success: false, error: "Pi authentication unavailable" }
  }
  if (!unifiedStore.getWalletStatus().isInitialized) {
    return { success: false, error: "Pi SDK is not initialized" }
  }

  try {
    const authResult = await window.Pi.authenticate(["payments", "wallet_address"], () => {})
    if (
      typeof authResult?.accessToken !== "string" ||
      authResult.accessToken.trim() === "" ||
      typeof authResult?.user?.uid !== "string" ||
      authResult.user.uid.trim() === ""
    ) {
      return { success: false, error: "Invalid Pi authentication response" }
    }
    return { success: true, accessToken: authResult.accessToken, uid: authResult.user.uid }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Pi authentication failed" }
  }
}
