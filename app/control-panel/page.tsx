"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BackButton } from "@/components/back-button"
import { getPaymentLink } from "@/lib/router"
import { CORE_VERSION, CORE_STATUS, CoreLogger } from "@/lib/core"
import { createPayment, getAllPayments } from "@/lib/operations"
import { runTestnetReadinessCheck, type ReadinessResult } from "@/lib/readiness-check"
import { useDomains } from "@/lib/domains"
import { useRouter } from "next/navigation"
import { SystemMonitor, errorTracker, auditLogger, OPERATIONAL_FLAGS } from "@/lib/security"
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Trash2,
  Plus,
  ExternalLink,
  Lock,
  Unlock,
  ArrowRight,
  Shield,
  Activity,
} from "lucide-react"
import { Switch } from "@/components/ui/switch"

export default function ControlPanelPage() {
  const router = useRouter()
  const [logs, setLogs] = useState<any[]>([])
  const [readinessResult, setReadinessResult] = useState<ReadinessResult | null>(null)
  const [isRunningCheck, setIsRunningCheck] = useState(false)
  const [piSDKStatus, setPiSDKStatus] = useState<"checking" | "available" | "unavailable">("checking")
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [systemHealth, setSystemHealth] = useState<any>(null)

  const { masterEnabled, setMasterEnabled, domains, setDomainEnabled } = useDomains()

  useEffect(() => {
    loadLogs()
    checkPiSDK()
    loadSystemHealth()
    const interval = setInterval(() => {
      loadLogs()
      loadSystemHealth()
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  const loadLogs = () => {
    setLogs(CoreLogger.getLogs(50))
  }

  const loadSystemHealth = () => {
    const health = SystemMonitor.getSystemHealth()
    setSystemHealth(health)
  }

  const checkPiSDK = async () => {
    if (typeof window !== "undefined" && window.Pi) {
      setPiSDKStatus("available")
    } else {
      setPiSDKStatus("unavailable")
    }
  }

  const handleCreateTestPayment = () => {
    const result = createPayment(1.0, "Test payment from Control Panel")
    if (result.success && result.data) {
      const link = getPaymentLink(result.data.id)
      router.push(link)
    }
  }

  const handleOpenLatestPayment = () => {
    const payments = getAllPayments()
    if (payments.length > 0) {
      const latest = payments[0]
      const link = getPaymentLink(latest.id)
      router.push(link)
    }
  }

  const handleClearData = () => {
    if (showClearConfirm) {
      localStorage.removeItem("flashpay_unified_state")
      CoreLogger.clearLogs()
      errorTracker.clearErrors()
      auditLogger.clearAudits()
      setLogs([])
      setShowClearConfirm(false)
      window.location.reload()
    } else {
      setShowClearConfirm(true)
      setTimeout(() => setShowClearConfirm(false), 3000)
    }
  }

  const handleRunReadinessCheck = async () => {
    setIsRunningCheck(true)
    const result = await runTestnetReadinessCheck()
    setReadinessResult(result)
    setIsRunningCheck(false)
  }

  const getStatusIcon = (status: "pass" | "fail" | "warning") => {
    switch (status) {
      case "pass":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "fail":
        return <XCircle className="h-4 w-4 text-red-600" />
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-600" />
    }
  }

  const allPayments = getAllPayments()
  const recentErrors = errorTracker.getRecentErrors(5)

  return (
    <div className="flex flex-col min-h-screen bg-gradient-to-b from-background to-muted/20">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-sm border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <BackButton />
          <div>
            <h1 className="font-semibold text-lg">Control Panel</h1>
            <p className="text-xs text-muted-foreground">Security & Operations v1</p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 py-6 space-y-6 pb-24">
        {/* System Status */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">System Status</CardTitle>
            <CardDescription>Core system information and configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Core Version</span>
              <Badge variant="outline">{CORE_VERSION}</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Core Status</span>
              <Badge>{CORE_STATUS}</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Testnet Mode</span>
              <Badge variant="secondary">Active</Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Domain</span>
              <span className="text-sm font-mono">{typeof window !== "undefined" ? window.location.hostname : ""}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Pi SDK</span>
              <Badge variant={piSDKStatus === "available" ? "default" : "secondary"}>
                {piSDKStatus === "checking"
                  ? "Checking..."
                  : piSDKStatus === "available"
                    ? "Connected"
                    : "Not Available"}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Payments in Store</span>
              <span className="text-sm font-semibold">{allPayments.length}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Security & Compliance</CardTitle>
                <CardDescription>Operational flags and security controls</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(OPERATIONAL_FLAGS).map(([key, value]) => (
              <div key={key} className="flex justify-between items-center p-2 rounded bg-muted/50 border">
                <span className="text-sm font-mono">{key}</span>
                <Badge variant={value ? "default" : "outline"}>{value ? "ENABLED" : "DISABLED"}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {systemHealth && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                <div>
                  <CardTitle className="text-lg">System Health</CardTitle>
                  <CardDescription>Real-time operational monitoring</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={`flex items-center gap-2 p-3 rounded-lg ${
                  systemHealth.status === "PASS"
                    ? "bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800"
                }`}
              >
                {systemHealth.status === "PASS" ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                )}
                <div>
                  <p className="font-semibold text-sm">
                    {systemHealth.status === "PASS" ? "All Systems Operational" : "Issues Detected"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last checked: {new Date(systemHealth.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Health Checks</p>
                {Object.entries(systemHealth.checks).map(([key, status]) => (
                  <div key={key} className="flex items-center justify-between p-2 rounded bg-muted/50 border">
                    <span className="text-sm">{key}</span>
                    <Badge variant={status === "PASS" ? "default" : "destructive"}>{status as string}</Badge>
                  </div>
                ))}
              </div>

              {recentErrors.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Recent Errors ({recentErrors.length})
                  </p>
                  {recentErrors.map((error) => (
                    <div
                      key={error.trackingId}
                      className="p-2 rounded bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-red-900 dark:text-red-100">{error.operation}</p>
                          <p className="text-xs text-red-700 dark:text-red-300 truncate">{error.error}</p>
                        </div>
                        <Badge variant="outline" className="text-xs font-mono shrink-0">
                          {error.trackingId}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Domain Management */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Domain Management</CardTitle>
            <CardDescription>Internal operational modules within the unified app</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Master Toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg border bg-background">
              <div className="flex items-center gap-2">
                {masterEnabled ? (
                  <Unlock className="h-4 w-4 text-green-600" />
                ) : (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <p className="font-semibold text-sm">Master Domain Control</p>
                  <p className="text-xs text-muted-foreground">
                    {masterEnabled ? "Individual domains can be toggled" : "Domain toggles are locked"}
                  </p>
                </div>
              </div>
              <Switch checked={masterEnabled} onCheckedChange={setMasterEnabled} />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Domains ({domains.filter((d) => d.enabled).length}/{domains.length} enabled)
              </p>
              {domains.map((domain) => (
                <div
                  key={domain.id}
                  className={`flex items-start justify-between p-3 rounded-lg border transition-colors ${
                    !masterEnabled ? "opacity-60" : ""
                  } ${domain.isPrimary ? "bg-muted/50" : ""}`}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div
                      className={`h-2 w-2 rounded-full flex-shrink-0 mt-1.5 ${
                        domain.enabled ? "bg-green-600" : "bg-muted-foreground"
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">{domain.name}</p>
                        {domain.isPrimary && (
                          <Badge variant="secondary" className="text-xs">
                            Primary
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono truncate mb-1">{domain.domain}</p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <ArrowRight className="h-3 w-3 flex-shrink-0" />
                        <span className="font-mono truncate">{domain.routes.join(", ")}</span>
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={domain.enabled}
                    onCheckedChange={(enabled) => setDomainEnabled(domain.id, enabled)}
                    disabled={!masterEnabled}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Actions</CardTitle>
            <CardDescription>Quick operations using unified system</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={handleCreateTestPayment} className="w-full" variant="default">
              <Plus className="h-4 w-4 mr-2" />
              Create Test Payment
            </Button>
            <Button
              onClick={handleOpenLatestPayment}
              className="w-full bg-transparent"
              variant="outline"
              disabled={allPayments.length === 0}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Open Latest Payment Link
            </Button>
            <Button onClick={handleClearData} className="w-full" variant={showClearConfirm ? "destructive" : "outline"}>
              <Trash2 className="h-4 w-4 mr-2" />
              {showClearConfirm ? "Click Again to Confirm" : "Clear Local Data"}
            </Button>
          </CardContent>
        </Card>

        {/* Testnet Readiness Check */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Testnet Readiness</CardTitle>
            <CardDescription>Comprehensive system validation</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={handleRunReadinessCheck} disabled={isRunningCheck} className="w-full">
              {isRunningCheck ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Running Checks...
                </>
              ) : (
                "Run Testnet Readiness Check"
              )}
            </Button>

            {readinessResult && (
              <div className="space-y-3 pt-2">
                <div
                  className={`flex items-center gap-2 p-3 rounded-lg ${
                    readinessResult.ready
                      ? "bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800"
                      : "bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800"
                  }`}
                >
                  {readinessResult.ready ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                  )}
                  <div>
                    <p className="font-semibold text-sm">
                      {readinessResult.ready ? "✅ Ready for Testnet" : "⚠️ Needs Fix"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Checked at {readinessResult.timestamp.toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  {readinessResult.checks.map((check, idx) => (
                    <div key={idx} className="flex items-start gap-2 p-2 rounded bg-muted/50 border">
                      <div className="mt-0.5">{getStatusIcon(check.status)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{check.name}</p>
                        <p className="text-xs text-muted-foreground">{check.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Logs Viewer */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">System Logs</CardTitle>
            <CardDescription>Latest 50 events from unified logging system</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-96 overflow-y-auto font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No logs yet</p>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`p-2 rounded border ${
                      log.level === "error"
                        ? "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800"
                        : log.level === "warn"
                          ? "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800"
                          : log.level === "guard"
                            ? "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800"
                            : "bg-muted/50"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-muted-foreground shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                      <Badge variant="outline" className="shrink-0 text-xs">
                        {log.level}
                      </Badge>
                      <span className="flex-1 break-all">{log.message}</span>
                    </div>
                    {log.details && (
                      <div className="mt-1 pl-2 text-muted-foreground text-xs">{JSON.stringify(log.details)}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
