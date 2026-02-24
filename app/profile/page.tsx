"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useRouter } from "next/navigation"
import { useMerchant } from "@/lib/use-merchant"
import { useDomains } from "@/lib/domains"
import { unifiedStore } from "@/lib/unified-store"
import { usePasswordAuth } from "@/lib/use-password-auth"
import { PasswordGate } from "@/components/password-gate"
import { ROUTES } from "@/lib/router"
import {
  Shield,
  Settings,
  BarChart3,
  Activity,
  Users,
  Lock,
  Unlock,
  ArrowRight,
  ExternalLink,
  LogOut,
  Stethoscope,
} from "lucide-react"

function ProfileContent() {
  const router = useRouter()
  const merchant = useMerchant()
  const { domains, masterEnabled } = useDomains()
  const { logout } = usePasswordAuth()
  const [mounted, setMounted] = useState(false)
  const [globalAnalytics, setGlobalAnalytics] = useState<any>(null)

  useEffect(() => {
    setMounted(true)
    loadAnalyticsSafely()
  }, [])

  const loadAnalyticsSafely = () => {
    try {
      if (typeof window === "undefined") return
      const analytics = unifiedStore.getGlobalAnalytics()
      setGlobalAnalytics({
        totalMerchants: analytics?.totalMerchants ?? 0,
        activeMerchants: analytics?.activeMerchants ?? 0,
        totalPayments: analytics?.totalPayments ?? 0,
        totalVolume: analytics?.totalVolume ?? 0,
        merchantAnalytics: Array.isArray(analytics?.merchantAnalytics) ? analytics.merchantAnalytics : [],
      })
    } catch (error) {
      console.error("[v0] Error loading analytics:", error)
      setGlobalAnalytics({
        totalMerchants: 0,
        activeMerchants: 0,
        totalPayments: 0,
        totalVolume: 0,
        merchantAnalytics: [],
      })
    }
  }

  const handleLogout = () => {
    if (confirm("Are you sure you want to log out? You'll need the password to access this page again.")) {
      logout()
      router.push("/")
    }
  }

  if (!mounted) {
    return null
  }

  const integrationDomains = domains.filter((d) => !d.isPrimary)

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Owner Profile</h1>
            </div>
            <Button onClick={handleLogout} variant="outline" size="sm" className="gap-2 bg-transparent">
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Platform operations & domain management</p>
          {merchant?.piUsername && <p className="text-xs text-muted-foreground mt-1">@{merchant.piUsername}</p>}
        </div>

        {/* Control Panel Access */}
        <Card className="border-2 border-primary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              Control Panel
            </CardTitle>
            <CardDescription>System operations, security, and monitoring</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/control-panel")} className="w-full" size="lg">
              <Shield className="h-4 w-4 mr-2" />
              Open Control Panel
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        <Card className="border-blue-500/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-blue-500" />
              System Diagnostics
            </CardTitle>
            <CardDescription>Check Pi SDK, wallet connection, and troubleshoot issues</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push(ROUTES.DIAGNOSTICS)} className="w-full" size="lg" variant="outline">
              <Activity className="h-4 w-4 mr-2" />
              Run Diagnostics
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        {/* Platform Stats */}
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

        {/* Domain Management Quick View */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Domain Management
              </div>
              <Badge variant={masterEnabled ? "default" : "secondary"}>
                {masterEnabled ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
                {masterEnabled ? "Unlocked" : "Locked"}
              </Badge>
            </CardTitle>
            <CardDescription>
              {domains.filter((d) => d.enabled).length}/{domains.length} domains enabled
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {domains.map((domain) => (
                <div
                  key={domain.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    domain.isPrimary ? "bg-primary/5 border-primary/20" : "bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${domain.enabled ? "bg-green-600" : "bg-muted-foreground"}`}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{domain.name}</span>
                        {domain.isPrimary && (
                          <Badge variant="secondary" className="text-xs">
                            Primary
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">{domain.domain}</p>
                    </div>
                  </div>
                  <Badge variant={domain.enabled ? "default" : "outline"}>
                    {domain.enabled ? "Active" : "Disabled"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Integration Domain Pages (8 Pages) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5" />
              Integration Domains ({integrationDomains.length})
            </CardTitle>
            <CardDescription>Access domain-specific operational pages</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3">
              {integrationDomains.map((domain) => (
                <Button
                  key={domain.id}
                  onClick={() => router.push(domain.routes[0])}
                  variant={domain.enabled ? "default" : "outline"}
                  disabled={!domain.enabled}
                  className="w-full justify-between h-auto py-3"
                >
                  <div className="text-left">
                    <div className="font-medium">{domain.name}</div>
                    <div className="text-xs opacity-80 font-normal">{domain.description}</div>
                  </div>
                  <ArrowRight className="h-4 w-4 ml-2 flex-shrink-0" />
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Merchant Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Merchant Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {globalAnalytics?.merchantAnalytics && globalAnalytics.merchantAnalytics.length > 0 ? (
                globalAnalytics.merchantAnalytics.map((m: any) => (
                  <div key={m.merchantId} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-mono text-sm text-muted-foreground">
                        ID: {m.merchantId?.substring(0, 12) ?? "Unknown"}
                      </div>
                      <Badge variant={(m.paidPayments ?? 0) > 0 ? "default" : "secondary"}>
                        {(m.paidPayments ?? 0) > 0 ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <div className="text-muted-foreground">Total</div>
                        <div className="font-semibold">{m.totalPayments ?? 0}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Paid</div>
                        <div className="font-semibold text-accent">{m.paidPayments ?? 0}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Volume</div>
                        <div className="font-semibold">{(m.totalAmount ?? 0).toFixed(2)} π</div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No merchant activity yet</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  return (
    <PasswordGate>
      <ProfileContent />
    </PasswordGate>
  )
}
