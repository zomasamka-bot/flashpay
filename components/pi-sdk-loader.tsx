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

  // For /pay/[id] routes OR hash-based #/pay/[id] routes, render children immediately and expose readiness promise
  const isPayRoute = pathname?.startsWith("/pay/") || (typeof window !== "undefined" && /^#\/pay\/[0-9a-f-]{36}\/?(?:\?.*)?$/i.test(window.location.hash))

  useEffect(() => {
    if (shouldSkipSDK) {
      setScriptLoaded(true)
      return
    }

    if (isPayRoute) setScriptLoaded(true)

    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const initializeLoadedSDK = async () => {
      if (!window.Pi || typeof window.Pi.init !== "function") throw new Error("Pi SDK loaded but Pi.init not available")
      await window.Pi.init({ version: "2.0", sandbox: false })
      window.__PI_SDK_LOADED__ = true
      CoreLogger.info("[DR93 PI SDK] loaded and initialized", { pathname })
    }

    // DR93: __PI_SDK_READY__ means one thing only: the SDK script is present AND Pi.init resolved.
    // Never publish a resolved readiness promise merely because window.Pi exists.
    if (!window.__PI_SDK_READY__) {
      window.__PI_SDK_READY__ = new Promise<void>((resolve, reject) => {
        const finish = async () => {
          try {
            await initializeLoadedSDK()
            if (timeoutId) clearTimeout(timeoutId)
            resolve()
            if (!cancelled && !isPayRoute) setScriptLoaded(true)
          } catch (cause) {
            if (timeoutId) clearTimeout(timeoutId)
            const sdkError = cause instanceof Error ? cause : new Error(String(cause))
            CoreLogger.error("[DR93 PI SDK] initialization failed", { error: sdkError.message })
            if (!cancelled) {
              setError(sdkError.message || "Pi SDK initialization failed")
              if (!isPayRoute) setScriptLoaded(true)
            }
            reject(sdkError)
          }
        }

        timeoutId = setTimeout(() => {
          const timeoutError = new Error("Pi SDK readiness timeout (15s)")
          CoreLogger.error("[DR93 PI SDK] readiness timeout", { error: timeoutError.message })
          if (!cancelled) setError("Pi SDK not available (timeout)")
          reject(timeoutError)
        }, 15000)

        if (window.Pi && typeof window.Pi.init === "function") {
          void finish()
          return
        }

        const existing = document.querySelector<HTMLScriptElement>('script[src="https://sdk.minepi.com/pi-sdk.js"]')
        const script = existing ?? document.createElement("script")
        if (!existing) {
          script.src = "https://sdk.minepi.com/pi-sdk.js"
          script.async = false
          script.defer = false
          document.head.appendChild(script)
        }
        script.addEventListener("load", () => { void finish() }, { once: true })
        script.addEventListener("error", () => {
          const loadError = new Error("Failed to load Pi SDK from CDN")
          if (timeoutId) clearTimeout(timeoutId)
          CoreLogger.error("[DR93 PI SDK] script load failed", { url: script.src })
          if (!cancelled) setError(loadError.message)
          reject(loadError)
        }, { once: true })
      })
    }

    // Observe the shared readiness promise so non-pay routes leave their loading shell.
    void window.__PI_SDK_READY__.then(() => {
      if (!cancelled && !isPayRoute) setScriptLoaded(true)
    }).catch(() => {
      if (!cancelled && !isPayRoute) setScriptLoaded(true)
    })

    return () => {
      cancelled = true
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [isPayRoute, pathname, shouldSkipSDK])

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
