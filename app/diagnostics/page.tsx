"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useRouter } from "next/navigation"
import { PasswordGate } from "@/components/password-gate"
import { BackButton } from "@/components/back-button"
import { ROUTES } from "@/lib/router"
import { Stethoscope, CheckCircle, AlertCircle, RefreshCw, Copy } from "lucide-react"

interface DiagnosticCheck {
  name: string
  status: "pass" | "warn" | "fail"
  message: string
  timestamp?: string
}

function DiagnosticsContent() {
  const router = useRouter()
  const [mounted, setMounted] = useState(false)
  const [checks, setChecks] = useState<DiagnosticCheck[]>([])
  const [isRunning, setIsRunning] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const runDiagnostics = async () => {
    setIsRunning(true)
    const results: DiagnosticCheck[] = []

    // Check 1: Pi SDK availability
    const piSdkCheck: DiagnosticCheck = {
      name: "Pi SDK",
      status: typeof window !== "undefined" && !!(window as any).Pi ? "pass" : "fail",
      message:
        typeof window !== "undefined" && !!(window as any).Pi
          ? "Pi SDK is available in window object"
          : "Pi SDK not detected in window object",
      timestamp: new Date().toISOString(),
    }
    results.push(piSdkCheck)

    // Check 2: Local Storage
    const localStorageCheck: DiagnosticCheck = {
      name: "Local Storage",
      status: "pass",
      message: "Local Storage is accessible",
      timestamp: new Date().toISOString(),
    }
    try {
      localStorage.setItem("__diagnostic_test", "ok")
      localStorage.removeItem("__diagnostic_test")
    } catch {
      localStorageCheck.status = "warn"
      localStorageCheck.message = "Local Storage is restricted or unavailable"
    }
    results.push(localStorageCheck)

    // Check 3: Window object
    const windowCheck: DiagnosticCheck = {
      name: "Window Object",
      status: typeof window !== "undefined" ? "pass" : "fail",
      message: typeof window !== "undefined" ? "Window object is available" : "Window object is not available",
      timestamp: new Date().toISOString(),
    }
    results.push(windowCheck)

    // Check 4: Session Storage
    const sessionStorageCheck: DiagnosticCheck = {
      name: "Session Storage",
      status: "pass",
      message: "Session Storage is accessible",
      timestamp: new Date().toISOString(),
    }
    try {
      sessionStorage.setItem("__diagnostic_test", "ok")
      sessionStorage.removeItem("__diagnostic_test")
    } catch {
      sessionStorageCheck.status = "warn"
      sessionStorageCheck.message = "Session Storage is restricted or unavailable"
    }
    results.push(sessionStorageCheck)

    // Check 5: Network connectivity
    const networkCheck: DiagnosticCheck = {
      name: "Network Connectivity",
      status: navigator.onLine ? "pass" : "warn",
      message: navigator.onLine ? "Network is connected" : "Network may be offline or restricted",
      timestamp: new Date().toISOString(),
    }
    results.push(networkCheck)

    // Check 6: Device info
    const deviceCheck: DiagnosticCheck = {
      name: "Device Information",
      status: "pass",
      message: `User Agent: ${navigator.userAgent.substring(0, 50)}...`,
      timestamp: new Date().toISOString(),
    }
    results.push(deviceCheck)

    // Check 7: Document ready
    const docCheck: DiagnosticCheck = {
      name: "DOM Ready",
      status: document.readyState === "complete" || document.readyState === "interactive" ? "pass" : "warn",
      message: `Document state: ${document.readyState}`,
      timestamp: new Date().toISOString(),
    }
    results.push(docCheck)

    // Check 8: Console availability
    const consoleCheck: DiagnosticCheck = {
      name: "Console API",
      status: typeof console !== "undefined" ? "pass" : "fail",
      message: typeof console !== "undefined" ? "Console is available for debugging" : "Console is not available",
      timestamp: new Date().toISOString(),
    }
    results.push(consoleCheck)

    setChecks(results)
    setIsRunning(false)
  }

  useEffect(() => {
    if (mounted && checks.length === 0) {
      runDiagnostics()
    }
  }, [mounted])

  if (!mounted) {
    return null
  }

  const passCount = checks.filter((c) => c.status === "pass").length
  const warnCount = checks.filter((c) => c.status === "warn").length
  const failCount = checks.filter((c) => c.status === "fail").length

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pass":
        return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200"
      case "warn":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200"
      case "fail":
        return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200"
      default:
        return "bg-gray-100 text-gray-700"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pass":
        return <CheckCircle className="h-4 w-4 text-green-600" />
      case "warn":
        return <AlertCircle className="h-4 w-4 text-yellow-600" />
      case "fail":
        return <AlertCircle className="h-4 w-4 text-red-600" />
      default:
        return null
    }
  }

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <BackButton />
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Stethoscope className="h-6 w-6 text-blue-600" />
              <h1 className="text-2xl font-bold">System Diagnostics</h1>
            </div>
            <p className="text-sm text-muted-foreground">Check Pi SDK, wallet connection, and troubleshoot issues</p>
          </div>
        </div>

        {/* Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Diagnostic Summary</span>
              <Button
                onClick={runDiagnostics}
                size="sm"
                variant="outline"
                disabled={isRunning}
                className="gap-1"
              >
                <RefreshCw className={`h-4 w-4 ${isRunning ? "animate-spin" : ""}`} />
                Re-run
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 border rounded-lg bg-green-50 dark:bg-green-950/30">
                <div className="text-3xl font-bold text-green-600">{passCount}</div>
                <div className="text-sm text-muted-foreground">Passed</div>
              </div>
              <div className="p-4 border rounded-lg bg-yellow-50 dark:bg-yellow-950/30">
                <div className="text-3xl font-bold text-yellow-600">{warnCount}</div>
                <div className="text-sm text-muted-foreground">Warnings</div>
              </div>
              <div className="p-4 border rounded-lg bg-red-50 dark:bg-red-950/30">
                <div className="text-3xl font-bold text-red-600">{failCount}</div>
                <div className="text-sm text-muted-foreground">Failed</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Diagnostic Results */}
        <Card>
          <CardHeader>
            <CardTitle>Diagnostic Results</CardTitle>
            <CardDescription>Detailed system health check</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {checks.map((check, idx) => (
                <div
                  key={idx}
                  className={`p-4 border rounded-lg ${getStatusColor(check.status)}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1">
                      {getStatusIcon(check.status)}
                      <div className="flex-1">
                        <div className="font-semibold text-sm">{check.name}</div>
                        <div className="text-xs opacity-80 mt-1">{check.message}</div>
                        {check.timestamp && (
                          <div className="text-xs opacity-60 mt-2 font-mono">{check.timestamp}</div>
                        )}
                      </div>
                    </div>
                    <Badge className={`capitalize text-xs font-mono`}>{check.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Help & Support */}
        <Card className="border-blue-500/50 bg-blue-50/50 dark:bg-blue-950/20">
          <CardHeader>
            <CardTitle className="text-blue-700 dark:text-blue-400">Troubleshooting Guide</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2 text-muted-foreground">
            <div>
              <strong>If Pi SDK fails:</strong> Ensure you are running inside Pi Browser and the SDK script is loaded.
            </div>
            <div>
              <strong>If storage is restricted:</strong> Check browser privacy settings and cookies configuration.
            </div>
            <div>
              <strong>If network is offline:</strong> Verify your internet connection and try again.
            </div>
            <div>
              <strong>Need more help?</strong> Contact support through the Pi app or check the documentation.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function DiagnosticsPage() {
  return (
    <PasswordGate>
      <DiagnosticsContent />
    </PasswordGate>
  )
}
