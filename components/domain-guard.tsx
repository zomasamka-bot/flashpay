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
  const [canAccess, setCanAccess] = useState(false)
  const [domain, setDomain] = useState<string>("")

  useEffect(() => {
    // DOMAIN GUARD DISABLED - Allow all routes
    // This app now runs on a single domain (flashpay-two.vercel.app)
    // No need for multi-domain access control
    console.log("[v0] Domain guard bypassed for route:", pathname)
    setCanAccess(true)
  }, [pathname])

  if (!canAccess) {
    return null
  }

  return <>{children}</>
}
