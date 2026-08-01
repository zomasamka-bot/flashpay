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
  }
}

/**
 * Component that ensures Pi SDK is loaded before the app initializes
 * OPTIMIZED FOR PI BROWSER: Non-blocking, renders content immediately
 */
export function PiSDKLoader({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [isReady, setIsReady] = useState(true) // Always render immediately
  const [error, setError] = useState<string | null>(null)

  // Routes that don't need Pi SDK initialization
  const skipSDKRoutes = ["/operations", "/control-panel", "/diagnostics", "/reset"]
  const shouldSkipSDK = skipSDKRoutes.some((route) => pathname?.startsWith(route))

  useEffect(() => {
    // For /pay/* routes in Pi Browser, render immediately without blocking
    // The payment page will handle SDK initialization independently if needed
    if (pathname?.startsWith("/pay/")) {
      console.log("[v0][PiSDKLoader] Payment route detected - rendering immediately in Pi Browser")
      setIsReady(true)
      // Still load SDK in background without blocking
      loadPiSDKAsync()
      return
    }

    // For other routes, still attempt to load SDK but don't block rendering
    loadPiSDKAsync()
  }, [pathname])

  const loadPiSDKAsync = () => {
    // Skip SDK loading for admin routes
    if (shouldSkipSDK) {
      return
    }

    // Check if script is already loaded
    if (window.__PI_SDK_LOADED__ || (window.Pi && typeof window.Pi.init === "function")) {
      return
    }

    // Load SDK in the background (non-blocking)
    if (typeof window === "undefined") return

    // Create script element
    const script = document.createElement("script")
    script.src = "https://sdk.minepi.com/pi-sdk.js"
    script.async = true // Allow async to not block page
    script.defer = true

    // Handle successful load
    script.onload = () => {
      setTimeout(() => {
        if (window.Pi && typeof window.Pi.init === "function") {
          window.__PI_SDK_LOADED__ = true
          console.log("[v0][PiSDKLoader] Pi SDK loaded successfully in background")
        } else {
          CoreLogger.error("Pi SDK script loaded but Pi object not available", {
            hasPi: !!window.Pi,
            piType: typeof window.Pi,
          })
        }
      }, 50) // Minimal delay
    }

    // Handle load error (non-blocking failure)
    script.onerror = (event) => {
      CoreLogger.error("Failed to load Pi SDK script", {
        error: event,
        url: script.src,
      })
      // Don't set error state - page renders anyway
    }

    // Add script to document (will load in background)
    if (document.head) {
      document.head.appendChild(script)
    }
  }

  // CRITICAL FIX: Always render content immediately, never block
  // Pi SDK loads in background if needed
  return <>{children}</>
}
