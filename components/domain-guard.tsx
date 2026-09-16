"use client"

import type React from "react"

import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Loader2 } from "lucide-react"

type Availability = { available: boolean; message: string }

// Owner operational routes must remain reachable while maintenance is active,
// otherwise the owner could not safely inspect or deactivate the control.
function isOperationalRoute(pathname: string) {
  return pathname === "/control-panel" || pathname === "/operations" || pathname.startsWith("/operations/") || pathname === "/diagnostics" || pathname === "/emergency"
}

export function DomainGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [availability, setAvailability] = useState<Availability | null>(null)

  const refreshAvailability = useCallback(async () => {
    if (isOperationalRoute(pathname)) {
      setAvailability({ available: true, message: "" })
      return
    }

    setAvailability(null)
    try {
      const response = await fetch("/api/control/availability", { cache: "no-store" })
      const data = await response.json().catch(() => null) as { available?: unknown; message?: unknown } | null
      if (data && typeof data.available === "boolean") {
        setAvailability({
          available: data.available,
          message: typeof data.message === "string" ? data.message : "",
        })
        return
      }
    } catch (error) {
      console.error("[System Control] Availability check failed:", error)
    }

    // Unknown control state fails closed for the user-facing application.
    setAvailability({ available: false, message: "Service temporarily unavailable. Please try again later." })
  }, [pathname])

  useEffect(() => {
    void refreshAvailability()
  }, [refreshAvailability])

  if (availability === null) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" aria-live="polite">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Checking service availability" />
      </div>
    )
  }

  if (!availability.available) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center pb-4">
            <div className="flex justify-center mb-4">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
            <CardTitle className="text-2xl">Service Temporarily Unavailable</CardTitle>
            <CardDescription className="text-base">FlashPay is currently in maintenance mode.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-center text-muted-foreground">
              {availability.message || "Maintenance in progress. Please try again later."}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 bg-transparent" onClick={() => router.back()}>
                Go Back
              </Button>
              <Button className="flex-1" onClick={() => void refreshAvailability()}>
                Check Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
