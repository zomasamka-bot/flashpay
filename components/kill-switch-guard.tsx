/**
 * Kill Switch Guard Component
 * Checks system state and blocks app access if kill switch is enabled.
 * This wraps the entire app and must render early to prevent any other content.
 */

"use client"

import { useEffect, useState } from "react"
import { config } from "@/lib/config"
import type { SystemState } from "@/lib/system-control"

export interface KillSwitchGuardProps {
  children: React.ReactNode
}

export function KillSwitchGuard({ children }: KillSwitchGuardProps) {
  const [state, setState] = useState<SystemState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const checkSystemState = async () => {
      try {
        // Add 2-second timeout (more aggressive) to prevent hanging
        const controller = new AbortController()
        const timeoutId = setTimeout(() => {
          console.warn("[Kill Switch Guard] System state check timeout")
          controller.abort()
        }, 2000)

        const response = await fetch(`${config.appUrl}/api/control/system`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        clearTimeout(timeoutId)

        if (!response.ok) throw new Error("Failed to fetch system state")
        const data: SystemState = await response.json()
        setState(data)
      } catch (err) {
        console.warn("[Kill Switch Guard] Failed to check system state (proceeding):", err)
        setError((err as Error)?.message || "Unknown error")
        // On error or timeout, fail open (allow access) - set to null to proceed
        setState(null)
      } finally {
        setIsLoading(false)
      }
    }

    checkSystemState()
    // Re-check every 30 seconds for kill switch status changes (less frequent to avoid blocking)
    const interval = setInterval(checkSystemState, 30000)
    return () => clearInterval(interval)
  }, [])

  // If we're still loading, show nothing (fail closed)
  if (isLoading) {
    // This shouldn't happen due to the timeout, but as a safety net,
    // the useEffect will force isLoading to false after completion
    return null
  }

  // If kill switch is enabled, show maintenance page
  if (state?.killSwitchEnabled) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-foreground">Maintenance</h1>
            <p className="text-foreground/60">{state.maintenanceMessage}</p>
          </div>

          {state.lastToggleTime && (
            <p className="text-xs text-foreground/40">
              Last updated: {new Date(state.lastToggleTime).toLocaleTimeString()}
            </p>
          )}

          <div className="pt-4">
            <p className="text-xs text-foreground/50 font-mono">
              [Kill Switch Active]
            </p>
          </div>
        </div>
      </div>
    )
  }

  // If there was an error fetching state, fail open (allow access)
  if (error) {
    console.warn("[Kill Switch Guard] Proceeding despite error:", error)
  }

  // App is active, render children
  return <>{children}</>
}
