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
import { ArrowRight, Settings, Stethoscope, Globe, BarChart3, AlertTriangle, RefreshCw, Loader2, Activity } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"

export default function OperationsPage() {
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [globalAnalytics, setGlobalAnalytics] = useState<{ totalMerchants: number; activeMerchants: number; totalPayments: number; totalVolume: number } | null>(null)
  const [overviewAsOf, setOverviewAsOf] = useState<string | null>(null)
  const [overviewError, setOverviewError] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [financialHealth, setFinancialHealth] = useState<{ postgres: { settled: number; settlementOpen: number; settlementFailed: number; refundPending: number; refundManualReview: number }; recovery: { active: number; ready: number; drainLeaseActive: boolean; piCreateBackpressureActive: boolean }; asOf: string } | null>(null)
  const [financialHealthError, setFinancialHealthError] = useState(false)
  const [financialHealthLoading, setFinancialHealthLoading] = useState(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const [incident, setIncident] = useState<{ overall: "healthy" | "degraded" | "maintenance" | "unknown"; reason: string; asOf: string; control: { available: boolean; killSwitchEnabled?: boolean; revision?: number }; financial: { settlementOpen:number; settlementFailed:number; refundPending:number; manualReview:number; oldestOpenAt:string|null } | null; recovery: { active:number; ready:number; lastWakeAt:string|null; lastWakeAgeMs:number|null; wakeFresh:boolean|null } | null } | null>(null)
  const [incidentLoading, setIncidentLoading] = useState(false)

  useEffect(() => {
    setMounted(true)
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

  const loadAnalyticsSafely = async () => {
    if (!uidData.accessToken) return
    setOverviewLoading(true)
    setOverviewError(false)
    try {
      const response = await fetch("/api/operations/overview", {
        headers: { Authorization: `Bearer ${uidData.accessToken}` },
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok || !data?.overview) throw new Error("Platform overview unavailable")
      setGlobalAnalytics(data.overview)
      setOverviewAsOf(typeof data.asOf === "string" ? data.asOf : null)
    } catch (error) {
      console.error("[operations] Error loading authoritative overview:", error)
      setGlobalAnalytics(null)
      setOverviewAsOf(null)
      setOverviewError(true)
    } finally {
      setOverviewLoading(false)
    }
  }

  useEffect(() => {
    if (uidData.status === "success" && uidData.uid === config.ownerUid && uidData.accessToken) {
      void loadAnalyticsSafely()
    }
  }, [uidData.status, uidData.uid, uidData.accessToken])

  const loadFinancialHealth = async () => {
    if (!uidData.accessToken) return
    setFinancialHealthLoading(true)
    setFinancialHealthError(false)
    try {
      const response = await fetch("/api/operations/financial-health", {
        headers: { Authorization: `Bearer ${uidData.accessToken}` },
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok || data?.available !== true || !data?.postgres || !data?.recovery || typeof data?.asOf !== "string") {
        throw new Error("Financial operations health unavailable")
      }
      setFinancialHealth({ postgres: data.postgres, recovery: data.recovery, asOf: data.asOf })
    } catch (error) {
      console.error("[operations] Error loading financial health:", error)
      setFinancialHealth(null)
      setFinancialHealthError(true)
    } finally {
      setFinancialHealthLoading(false)
    }
  }

  useEffect(() => {
    if (uidData.status === "success" && uidData.uid === config.ownerUid && uidData.accessToken) {
      void loadFinancialHealth()
    }
  }, [uidData.status, uidData.uid, uidData.accessToken])

  const loadIncidentHealth = async () => {
    if (!uidData.accessToken) return
    setIncidentLoading(true)
    try {
      const response = await fetch("/api/operations/incident-health", { headers: { Authorization: `Bearer ${uidData.accessToken}` }, cache: "no-store" })
      const data = await response.json()
      if (!response.ok || typeof data?.overall !== "string" || typeof data?.asOf !== "string") throw new Error("Incident health unavailable")
      setIncident(data)
    } catch (error) { console.error("[operations] incident health unavailable", error); setIncident({ overall: "unknown", reason: "Authoritative incident health is unavailable", asOf: new Date().toISOString(), control: { available: false }, financial: null, recovery: null }) }
    finally { setIncidentLoading(false) }
  }

  useEffect(() => { if (uidData.status === "success" && uidData.uid === config.ownerUid && uidData.accessToken) void loadIncidentHealth() }, [uidData.status, uidData.uid, uidData.accessToken])



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
    <div className="min-h-screen pb-6 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        <div className="mb-2">
          <h1 className="text-3xl font-bold">Operations Console</h1>
          <p className="text-sm text-muted-foreground mt-1">Platform management and monitoring</p>
        </div>

        {/* M10: incident mode and observability. Read-only; never a financial authority. */}
        <Card className={incident?.overall === "healthy" ? "border-green-500/50" : incident?.overall === "maintenance" ? "border-blue-500/50" : incident?.overall === "degraded" ? "border-amber-500/60" : "border-yellow-500/60"}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Activity className="h-5 w-5"/>System Health</span><span className="text-sm font-semibold uppercase">{incidentLoading ? "CHECKING" : incident?.overall ?? "UNKNOWN"}</span></CardTitle>
            <CardDescription>{incident?.reason ?? "Reading authoritative operational evidence…"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-muted-foreground">Settlement open</div><div className="text-xl font-bold">{incident?.financial?.settlementOpen ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Failures</div><div className="text-xl font-bold">{incident?.financial?.settlementFailed ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Refund pending</div><div className="text-xl font-bold">{incident?.financial?.refundPending ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Manual review</div><div className="text-xl font-bold">{incident?.financial?.manualReview ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Recovery active</div><div className="text-xl font-bold">{incident?.recovery?.active ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Wallet ready</div><div className="text-xl font-bold">{incident?.recovery?.ready ?? "—"}</div></div>
              <div><div className="text-muted-foreground">Worker wake</div><div className="text-sm font-semibold">{incident?.recovery?.wakeFresh === true ? "Fresh" : incident?.recovery?.wakeFresh === false ? "Stale" : "Unknown"}</div></div>
              <div><div className="text-muted-foreground">Control</div><div className="text-sm font-semibold">{incident?.control.available ? (incident.control.killSwitchEnabled ? "Maintenance" : "Online") : "Unknown"}</div></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{incident ? `as of ${new Date(incident.asOf).toLocaleString()}${incident.recovery?.lastWakeAt ? ` · last wake ${new Date(incident.recovery.lastWakeAt).toLocaleString()}` : ""}` : "Loading…"}</span>
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => void loadIncidentHealth()} disabled={incidentLoading || !uidData.accessToken}>{incidentLoading ? <Loader2 className="h-3 w-3 animate-spin"/> : <RefreshCw className="h-3 w-3"/>} Refresh</Button>
            </div>
          </CardContent>
        </Card>

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
                <div className="text-3xl font-bold">{overviewLoading ? "…" : globalAnalytics?.totalMerchants ?? "—"}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Active</div>
                <div className="text-3xl font-bold text-accent">{overviewLoading ? "…" : globalAnalytics?.activeMerchants ?? "—"}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Payments</div>
                <div className="text-3xl font-bold">{overviewLoading ? "…" : globalAnalytics?.totalPayments ?? "—"}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Volume</div>
                <div className="text-3xl font-bold text-primary">
                  {overviewLoading ? "…" : globalAnalytics ? `${globalAnalytics.totalVolume.toFixed(2)} π` : "—"}
                </div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{overviewError ? "Authoritative platform overview unavailable" : overviewAsOf ? `PostgreSQL · as of ${new Date(overviewAsOf).toLocaleString()}` : "Loading authoritative platform overview…"}</span>
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => void loadAnalyticsSafely()} disabled={overviewLoading || !uidData.accessToken}>
                {overviewLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* M6: read-only financial operations health. Never a financial decision authority. */}
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5" />
              Financial Operations Health
            </CardTitle>
            <CardDescription>Authoritative read-only settlement, refund, and recovery signals</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {financialHealthError ? (
              <Alert variant="destructive"><AlertDescription>Financial health is unavailable. No healthy state is inferred.</AlertDescription></Alert>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div><div className="text-muted-foreground">Settled</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.postgres.settled ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Settlement open</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.postgres.settlementOpen ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Settlement failed</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.postgres.settlementFailed ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Refund pending</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.postgres.refundPending ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Manual review</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.postgres.refundManualReview ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Recovery active</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.recovery.active ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Wallet ready</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth?.recovery.ready ?? "—"}</div></div>
                  <div><div className="text-muted-foreground">Pi create pressure</div><div className="text-2xl font-bold">{financialHealthLoading ? "…" : financialHealth ? (financialHealth.recovery.piCreateBackpressureActive ? "ACTIVE" : "Clear") : "—"}</div></div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{financialHealth ? `PostgreSQL + Redis · as of ${new Date(financialHealth.asOf).toLocaleString()} · drain lease ${financialHealth.recovery.drainLeaseActive ? "active" : "idle"}` : "Loading authoritative financial health…"}</span>
                  <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => void loadFinancialHealth()} disabled={financialHealthLoading || !uidData.accessToken}>
                    {financialHealthLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
                  </Button>
                </div>
              </>
            )}
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
