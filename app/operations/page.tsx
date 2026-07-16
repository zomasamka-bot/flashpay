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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ArrowRight, Settings, Stethoscope, Globe, BarChart3, ArrowLeft, AlertTriangle, RefreshCw, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { unifiedStore } from "@/lib/unified-store"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"

export default function OperationsPage() {
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [globalAnalytics, setGlobalAnalytics] = useState<any>(null)
  const [accessDenied, setAccessDenied] = useState(false)

  useEffect(() => {
    setMounted(true)
    loadAnalyticsSafely()
  }, [])

  // Silent access check - redirect if not owner, otherwise allow access
  useEffect(() => {
    if (!mounted) return

    // Owner verified - allow access
    if (uidData.status === "success" && uidData.uid === config.ownerUid) {
      return
    }

    // Explicitly not owner - deny access
    if (uidData.status === "success" && uidData.uid !== config.ownerUid) {
      setAccessDenied(true)
      return
    }

    // For any other state (idle, pending), assume access is allowed 
    // Owner will be redirected if uidData eventually shows they're not owner
  }, [mounted, uidData.status, uidData.uid])

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

  // SECURITY: Check owner authorization - only render if verified as owner
  const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid
  
  // Deny access if verified but not owner
  if (uidData.status === "success" && !isOwner) {
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

  // Only render console when owner is verified
  if (!isOwner) {
    return null
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

          {/* Emergency Payment Recovery */}
          <Card className="border-red-500/50 bg-red-50/50 dark:bg-red-950/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" />
                Emergency Payment Recovery
              </CardTitle>
              <CardDescription>Clear stuck pending payments securely</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                If payments are stuck and blocking the system, use the emergency recovery page to clear them securely with owner authentication.
              </p>
              <Button
                onClick={() => router.push("/emergency")}
                className="w-full"
                size="lg"
                variant="destructive"
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                Go to Emergency Recovery
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

          {/* Control Panel (Kill Switch) */}
          <Card className="border-2 border-primary md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Control Panel
              </CardTitle>
              <CardDescription>System operations and emergency kill switch</CardDescription>
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
        </div>
      </div>
    </div>
  )
}
