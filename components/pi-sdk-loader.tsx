"use client"

import type React from "react"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import { CoreLogger } from "@/lib/core"

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
    __PI_SDK_LOADED__?: boolean
    __PI_SDK_READY__?: Promise<void>
  }
}

/**
 * Component that ensures Pi SDK is loaded before the app initializes
 */
export function PiSDKLoader({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Routes that don't need Pi SDK initialization
  const skipSDKRoutes = ["/operations", "/control-panel", "/diagnostics", "/reset"]
  const shouldSkipSDK = skipSDKRoutes.some((route) => pathname?.startsWith(route))

  // For /pay/[id] routes, render children immediately and expose readiness promise
  const isPayRoute = pathname?.startsWith("/pay/")

  useEffect(() => {
    // Skip SDK loading for admin routes - owner is already verified
    if (shouldSkipSDK) {
      setScriptLoaded(true)
      return
    }

    // For /pay/[id] routes, render children immediately
    if (isPayRoute) {
      setScriptLoaded(true)
    }

    // Check if script is already loaded
    if (window.__PI_SDK_LOADED__ || (window.Pi && typeof window.Pi.init === "function")) {
      if (!isPayRoute) {
        setScriptLoaded(true)
      }
      // Ensure readiness promise is set
      if (!window.__PI_SDK_READY__) {
        window.__PI_SDK_READY__ = Promise.resolve()
      }
      return
    }

    // Create script element
    const script = document.createElement("script")
    script.src = "https://sdk.minepi.com/pi-sdk.js"
    script.async = false
    script.defer = false

    // Create a promise that resolves when window.Pi.init is available
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    // Set timeout to reject promise after 15s
    const timeoutId = setTimeout(() => {
      const timeoutError = new Error("Pi SDK readiness timeout (15s)")
      CoreLogger.error("Pi SDK readiness timeout", { error: timeoutError.message })
      rejectReady(timeoutError)
      // For /pay routes, set error to release UI after timeout
      if (isPayRoute) {
        setError("Pi SDK not available (timeout)")
      }
    }, 15000)

    // Handle successful load
    script.onload = () => {
      setTimeout(() => {
        if (window.Pi && typeof window.Pi.init === "function") {
          window.__PI_SDK_LOADED__ = true
          window.__PI_SDK_READY__ = Promise.resolve()
          clearTimeout(timeoutId)
          resolveReady()
          if (!isPayRoute) {
            setScriptLoaded(true)
          }
        } else {
          CoreLogger.error("Pi SDK script loaded but Pi object not available", {
            hasPi: !!window.Pi,
            piType: typeof window.Pi,
          })
          clearTimeout(timeoutId)
          rejectReady(new Error("Pi SDK loaded but Pi.init not available"))
          setError("Pi SDK loaded but not initialized properly")
          if (!isPayRoute) {
            setScriptLoaded(true)
          }
        }
      }, 100)
    }

    // Handle load error
    script.onerror = (event) => {
      CoreLogger.error("Failed to load Pi SDK script", {
        error: event,
        url: script.src,
      })
      clearTimeout(timeoutId)
      rejectReady(new Error("Failed to load Pi SDK from CDN"))
      setError("Failed to load Pi SDK from CDN")
      if (!isPayRoute) {
        setScriptLoaded(true)
      }
    }

    // Set readiness promise immediately for /pay routes
    window.__PI_SDK_READY__ = readyPromise

    // Add script to document
    document.head.appendChild(script)

    // Cleanup: never remove the loaded script
    return () => {
      clearTimeout(timeoutId)
    }
  }, [isPayRoute, shouldSkipSDK])

  // For /pay/[id] routes, render children immediately but show error if SDK failed
  if (isPayRoute) {
    if (error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="text-center max-w-sm px-4">
            <div className="mb-4 inline-block h-12 w-12 text-yellow-600">
              <span className="text-4xl">⚠️</span>
            </div>
            <h1 className="text-xl font-semibold mb-2">SDK Unavailable</h1>
            <p className="text-sm text-muted-foreground mb-4">{error}</p>
            <p className="text-xs text-muted-foreground">Please refresh or try again in Pi Browser</p>
          </div>
        </div>
      )
    }
    return <>{children}</>
  }

  if (!scriptLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
          <p className="text-sm text-muted-foreground">Loading Pi SDK...</p>
        </div>
      </div>
    )
  }

  if (error) {
    CoreLogger.error("Pi SDK Loader error:", error)
  }

  return <>{children}</>
}
