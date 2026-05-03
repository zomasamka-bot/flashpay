"use client"

import type React from "react"

import { useEffect, useState } from "react"
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
  }
}

/**
 * Component that ensures Pi SDK is loaded before the app initializes
 */
export function PiSDKLoader({ children }: { children: React.ReactNode }) {
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Check if script is already loaded
    if (window.__PI_SDK_LOADED__ || (window.Pi && typeof window.Pi.init === "function")) {
      setScriptLoaded(true)
      return
    }

    // Create script element
    const script = document.createElement("script")
    script.src = "https://sdk.minepi.com/pi-sdk.js"
    script.async = false
    script.defer = false

    // Handle successful load
    script.onload = () => {
      setTimeout(() => {
        if (window.Pi && typeof window.Pi.init === "function") {
          window.__PI_SDK_LOADED__ = true
          setScriptLoaded(true)
        } else {
          CoreLogger.error("Pi SDK script loaded but Pi object not available", {
            hasPi: !!window.Pi,
            piType: typeof window.Pi,
          })
          setError("Pi SDK loaded but not initialized properly")
          setScriptLoaded(true)
        }
      }, 100)
    }

    // Handle load error
    script.onerror = (event) => {
      CoreLogger.error("Failed to load Pi SDK script", {
        error: event,
        url: script.src,
      })
      setError("Failed to load Pi SDK from CDN")
      setScriptLoaded(true)
    }

    // Add script to document
    document.head.appendChild(script)

    // Cleanup
    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script)
      }
    }
  }, [])

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
