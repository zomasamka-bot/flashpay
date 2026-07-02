/**
 * Operations Console Dashboard
 * Central hub for platform management and owner-level operations
 * 
 * SECURITY: This page is owner-only. Non-owners are redirected to home.
 */

"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowRight, Settings, Stethoscope, Globe, BarChart3, ArrowLeft } from "lucide-react"
import { unifiedStore } from "@/lib/unified-store"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { useMerchant } from "@/lib/use-merchant"
import { config } from "@/lib/config"

export default function OperationsPage() {
  const router = useRouter()
  const merchant = useMerchant()
  const { uidData, verifyUid } = useOwnerUid()
  const [mounted, setMounted] = useState(false)
  const [globalAnalytics, setGlobalAnalytics] = useState<any>(null)
  const [accessDenied, setAccessDenied] = useState(false)

  useEffect(() => {
    setMounted(true)
    loadAnalyticsSafely()
  }, [])

  // Verify owner access on mount and when merchant data changes
  useEffect(() => {
    if (!mounted) return

    // If already verified as owner via new system, allow access
    if (uidData.status === "success" && uidData.uid === config.ownerUid) {
      console.log("[operations] Owner verified via new system - access granted")
      return
    }

    // If merchant data is available, attempt verification
    if (merchant?.uid && merchant?.accessToken && !uidData.uid) {
      console.log("[operations] Attempting owner verification")
      verifyUid(merchant.uid, merchant.accessToken).catch((err) => {
        console.error("[operations] Owner verification failed:", err)
      })
      return
    }

    // If no merchant data and verification hasn't succeeded, deny access
    if (!merchant?.uid) {
      console.warn("[operations] No merchant data - denying access")
      setAccessDenied(true)
      return
    }
  }, [mounted, merchant?.uid, merchant?.accessToken, uidData.status, uidData.uid, verifyUid])

  const loadAnalyticsSafely = () => {
    try {
      if (typeof window === "undefined") return
      const analytics = unifiedStore.getGlobalAnalytics()
      setGlobalAnalytics({
        totalMerchants: analytics?.totalMerchants ?? 0,
        activeMerchants: analytics?.activeMerchants ?? 0,
        totalPayments: analytics?.totalPayments ?? 0,
        totalVolume: analytics?.totalVolume ?? 0,
      })
    } catch (error) {
      console.error("[operations] Error loading analytics:", error)
      setGlobalAnalytics({
        totalMerchants: 0,
        activeMerchants: 0,
        totalPayments: 0,
        totalVolume: 0,
      })
    }
  }

  if (!mounted) {
    return null
  }

  // SECURITY: Check owner authorization
  const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid
  
  if (accessDenied || !isOwner) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="w-full max-w-md border-red-500/50">
          <CardHeader>
            <CardTitle className="text-red-600">Access Denied</CardTitle>
            <CardDescription>You do not have permission to access the Operations Console.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => router.push("/")}
              className="w-full"
            >
              Return to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold">Operations Console</h1>
              <p className="text-sm text-muted-foreground mt-1">Platform management and monitoring</p>
            </div>
            <Button
              onClick={() => router.push("/profile")}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Profile
            </Button>
          </div>
        </div>

        {/* Platform Statistics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Platform Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Merchants</div>
                <div className="text-3xl font-bold">{globalAnalytics?.totalMerchants ?? 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Active</div>
                <div className="text-3xl font-bold text-accent">{globalAnalytics?.activeMerchants ?? 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Payments</div>
                <div className="text-3xl font-bold">{globalAnalytics?.totalPayments ?? 0}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Volume</div>
                <div className="text-3xl font-bold text-primary">
                  {(globalAnalytics?.totalVolume ?? 0).toFixed(2)} π
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Operations Tools Grid */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* Control Panel */}
          <Card className="border-2 border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Control Panel
              </CardTitle>
              <CardDescription>System operations and security controls</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/control-panel")}
                className="w-full"
                size="lg"
              >
                Open Control Panel
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>

          {/* System Diagnostics */}
          <Card className="border-blue-500/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Stethoscope className="h-5 w-5 text-blue-500" />
                System Diagnostics
              </CardTitle>
              <CardDescription>Check health and troubleshoot issues</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/diagnostics")}
                className="w-full"
                size="lg"
                variant="outline"
              >
                Run Diagnostics
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>

          {/* Domain Management */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5" />
                Domain Management
              </CardTitle>
              <CardDescription>Configure integration domains</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/operations/domains")}
                className="w-full"
                size="lg"
                variant="outline"
              >
                Manage Domains
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
