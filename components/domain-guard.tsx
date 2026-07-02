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
    // DOMAIN GUARD DISABLED - Allow all routes
    // This app now runs on a single domain (flashpay-two.vercel.app)
    // No need for multi-domain access control
    console.log("[v0] Domain guard bypassed for route:", pathname)
    setCanAccess(true)
    setIsChecking(false)
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
