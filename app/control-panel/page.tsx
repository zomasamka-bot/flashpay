/**
 * Real Operational Control Panel
 * Manages system-wide controls including kill switch for emergency shutdown.
 */

"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { config } from "@/lib/config"
import type { SystemState } from "@/lib/system-control"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { BackButton } from "@/components/back-button"
import { AlertTriangle, Power, RefreshCw, CheckCircle2 } from "lucide-react"

export default function ControlPanelPage() {
  const router = useRouter()
  const [systemState, setSystemState] = useState<SystemState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isToggling, setIsToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Fetch current system state
  const fetchSystemState = useCallback(async () => {
    try {
      setError(null)
      const response = await fetch(`${config.appUrl}/api/control/system`)
      if (!response.ok) throw new Error("Failed to fetch system state")
      const data: SystemState = await response.json()
      setSystemState(data)
    } catch (err) {
      setError((err as Error)?.message || "Unknown error")
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Load initial state
  useEffect(() => {
    fetchSystemState()
  }, [fetchSystemState])

  // Toggle kill switch
  const handleToggleKillSwitch = useCallback(
    async (enable: boolean) => {
      if (!confirm(`Are you sure? This will ${enable ? "DISABLE" : "ENABLE"} the entire application.`)) {
        return
      }

      setIsToggling(true)
      setError(null)
      setSuccess(null)

      try {
        const response = await fetch(`${config.appUrl}/api/control/system`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: enable ? "enable" : "disable",
            message: enable ? "Maintenance in progress. Please try again later." : undefined,
          }),
        })

        if (!response.ok) throw new Error("Failed to toggle kill switch")
        const data = await response.json()

        setSystemState(data.state)
        setSuccess(data.message)

        // Show brief success message then redirect
        setTimeout(() => {
          router.push("/profile")
        }, 2000)
      } catch (err) {
        setError((err as Error)?.message || "Failed to toggle kill switch")
      } finally {
        setIsToggling(false)
      }
    },
    [router]
  )

  // Reset system state
  const handleReset = useCallback(async () => {
    if (!confirm("Are you sure? This will reset the system to its default state.")) {
      return
    }

    setIsToggling(true)
    setError(null)
    setSuccess(null)

    try {
      const response = await fetch(`${config.appUrl}/api/control/system`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      })

      if (!response.ok) throw new Error("Failed to reset system")
      const data = await response.json()

      setSystemState(data.state)
      setSuccess(data.message)
    } catch (err) {
      setError((err as Error)?.message || "Failed to reset system")
    } finally {
      setIsToggling(false)
    }
  }, [])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-center pt-20">
            <div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            <p className="text-foreground/60 mt-4">Loading control panel...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-background p-4 pb-24">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">Control Panel</h1>
          <BackButton />
        </div>

        {/* Status Alert */}
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
            <AlertDescription className="text-green-800 dark:text-green-200">{success}</AlertDescription>
          </Alert>
        )}

        {/* System Status */}
        <Card>
          <CardHeader>
            <CardTitle>System Status</CardTitle>
            <CardDescription>Current operational state</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-background/50 rounded-lg border">
              <div>
                <p className="font-medium text-foreground">App Status</p>
                <p className="text-sm text-foreground/60">
                  {systemState?.killSwitchEnabled ? "Disabled (Maintenance)" : "Active"}
                </p>
              </div>
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                systemState?.killSwitchEnabled
                  ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                  : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
              }`}>
                {systemState?.killSwitchEnabled ? "OFFLINE" : "ONLINE"}
              </div>
            </div>

            {systemState?.maintenanceMessage && (
              <div className="p-4 bg-background/50 rounded-lg border">
                <p className="text-sm font-medium text-foreground mb-2">Maintenance Message</p>
                <p className="text-sm text-foreground/60 font-mono">{systemState.maintenanceMessage}</p>
              </div>
            )}

            {systemState?.lastToggleTime && (
              <div className="text-xs text-foreground/50">
                Last updated: {new Date(systemState.lastToggleTime).toLocaleString()}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Kill Switch Control */}
        <Card className="border-red-200 dark:border-red-900">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <Power className="h-5 w-5" />
              Emergency Kill Switch
            </CardTitle>
            <CardDescription>Immediately disable the entire application</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Activating the kill switch will make the app completely inaccessible. All users will see a maintenance page.
              </AlertDescription>
            </Alert>

            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => handleToggleKillSwitch(true)}
                disabled={isToggling || systemState?.killSwitchEnabled}
                variant="destructive"
                size="lg"
                className="w-full"
              >
                {isToggling ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Activating...
                  </>
                ) : (
                  <>
                    <Power className="h-4 w-4 mr-2" />
                    Activate
                  </>
                )}
              </Button>

              <Button
                onClick={() => handleToggleKillSwitch(false)}
                disabled={isToggling || !systemState?.killSwitchEnabled}
                variant="outline"
                size="lg"
                className="w-full"
              >
                {isToggling ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Deactivating...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Deactivate
                  </>
                )}
              </Button>
            </div>

            <p className="text-xs text-foreground/50 text-center">
              Kill switch will auto-reset after 24 hours if not manually disabled.
            </p>
          </CardContent>
        </Card>

        {/* System Reset */}
        <Card>
          <CardHeader>
            <CardTitle>System Reset</CardTitle>
            <CardDescription>Reset all system controls to default state</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This will reset all system controls to their default state. Use only if the system is in an unknown state.
              </AlertDescription>
            </Alert>

            <Button
              onClick={handleReset}
              disabled={isToggling}
              variant="outline"
              size="lg"
              className="w-full"
            >
              {isToggling ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  Resetting...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reset System
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Footer Note */}
        <div className="text-center text-xs text-foreground/50">
          <p>Changes take effect immediately across all active sessions.</p>
          <p>Users will be notified within 10 seconds of any status changes.</p>
        </div>
      </div>
    </main>
  )
}
