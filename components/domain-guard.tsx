"use client"

import type React from "react"

import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { domainStore } from "@/lib/domains"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"
import { ROUTES } from "@/lib/router"

/**
 * Domain Guard Component
 * Checks if the current route is accessible based on domain status
 * Shows "Service Disabled" screen if domain is suspended
 */
export function DomainGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [isChecking, setIsChecking] = useState(true)
  const [canAccess, setCanAccess] = useState(false)
  const [domain, setDomain] = useState<string>("")

  useEffect(() => {
    const checkAccess = () => {
      console.log("[v0][DomainGuard] ========== CHECKING ACCESS ==========")
      console.log("[v0][DomainGuard] Current pathname:", pathname)
      console.log("[v0][DomainGuard] Starts with /pay?", pathname.startsWith('/pay'))
      
      // ALWAYS allow /pay routes (customer payment pages) to bypass domain guard
      if (pathname.startsWith('/pay')) {
        console.log("[v0][DomainGuard] ✅ PAYMENT PAGE - BYPASSING DOMAIN CHECK")
        setCanAccess(true)
        setIsChecking(false)
        return
      }

      console.log("[v0][DomainGuard] Checking domain access for:", pathname)
      const domainForRoute = domainStore.getDomainForRoute(pathname)
      const hasAccess = domainStore.canAccessRoute(pathname)
      
      console.log("[v0][DomainGuard] Domain:", domainForRoute?.name)
      console.log("[v0][DomainGuard] Has access:", hasAccess)

      setCanAccess(hasAccess)
      setDomain(domainForRoute?.name || "Unknown")
      setIsChecking(false)
    }

    checkAccess()

    // Subscribe to domain changes
    const unsubscribe = domainStore.subscribe(checkAccess)
    return unsubscribe
  }, [pathname])

  if (isChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-primary border-r-transparent mb-4"></div>
          <p className="text-muted-foreground">Checking access...</p>
        </div>
      </div>
    )
  }

  if (!canAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center pb-4">
            <div className="flex justify-center mb-4">
              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
            <CardTitle className="text-2xl">Service Disabled</CardTitle>
            <CardDescription className="text-base">The {domain} domain is currently suspended</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-center text-muted-foreground">
              This service has been disabled by the system administrator. Please contact support or try again later.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 bg-transparent" onClick={() => router.back()}>
                Go Back
              </Button>
              <Button className="flex-1" onClick={() => router.push(ROUTES.HOME)}>
                Go Home
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
