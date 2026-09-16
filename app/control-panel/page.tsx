/**
 * Owner operational control panel.
 * M9: fresh owner authorization, explicit reason, revision guard and deliberate confirmation.
 */

"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { config } from "@/lib/config"
import type { SystemState } from "@/lib/system-control"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertTriangle, Power, RefreshCw, CheckCircle2, ShieldAlert } from "lucide-react"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { OwnerOperationsHeader } from "@/components/owner-operations-header"

type ControlAction = "enable" | "disable" | "reset"

function ControlPanelContent() {
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const [mounted, setMounted] = useState(false)
  const [systemState, setSystemState] = useState<SystemState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isToggling, setIsToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const writeInFlightRef = useRef(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!mounted) return
    if (uidData.status === "success" && uidData.uid !== config.ownerUid) router.push("/")
  }, [mounted, uidData.status, uidData.uid, router])

  const fetchSystemState = useCallback(async () => {
    if (!uidData.accessToken) return
    setIsLoading(true)
    try {
      setError(null)
      const response = await fetch(`${config.appUrl}/api/control/system`, {
        headers: { Authorization: `Bearer ${uidData.accessToken}` },
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || "Failed to fetch system state")
      setSystemState(data as SystemState)
    } catch (err) {
      setSystemState(null)
      setError((err as Error)?.message || "Control state unavailable")
    } finally {
      setIsLoading(false)
    }
  }, [uidData.accessToken])

  useEffect(() => { void fetchSystemState() }, [fetchSystemState])

  const executeControl = useCallback(async (action: ControlAction) => {
    if (writeInFlightRef.current || !systemState || !uidData.accessToken) return
    const cleanReason = reason.trim()
    if (!cleanReason) {
      setError("Enter an operational reason before changing control state.")
      return
    }

    const confirmation = action === "enable" ? "ACTIVATE" : action === "disable" ? "DEACTIVATE" : "RESTORE"
    const typed = window.prompt(document.documentElement.lang === "ar" ? `تحكم عالي التأثير للمالك. اكتب ${confirmation} للمتابعة.` : `High-impact owner control. Type ${confirmation} to continue.`)
    if (typed !== confirmation) return

    writeInFlightRef.current = true
    setIsToggling(true)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch(`${config.appUrl}/api/control/system`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${uidData.accessToken}`,
        },
        body: JSON.stringify({
          action,
          reason: cleanReason,
          expectedRevision: systemState.revision,
          message: action === "enable" ? "Maintenance in progress. Please try again later." : undefined,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (response.status === 409 && data?.state) setSystemState(data.state)
        throw new Error(data?.error || "Control change failed")
      }
      setSystemState(data.state)
      setReason("")
      setSuccess(`${data.message} · request ${data.requestId}`)
    } catch (err) {
      setError((err as Error)?.message || "Control change failed")
    } finally {
      // A control write can succeed while audit persistence becomes uncertain.
      // Always re-read canonical state before allowing another destructive action.
      await fetchSystemState()
      writeInFlightRef.current = false
      setIsToggling(false)
    }
  }, [reason, systemState, uidData.accessToken, fetchSystemState])

  if (!mounted || uidData.status !== "success" || uidData.uid !== config.ownerUid) return null

  if (isLoading) {
    return <div className="min-h-screen bg-background p-4"><div className="max-w-2xl mx-auto text-center pt-20"><div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /><p className="text-foreground/60 mt-4">Loading authoritative control state...</p></div></div>
  }

  return (
    <>
    <OwnerOperationsHeader />
    <main className="min-h-screen bg-background p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="max-w-2xl mx-auto space-y-6">
        <div><h1 className="text-3xl font-bold">Control Panel</h1><p className="text-xs text-muted-foreground mt-1">Owner control plane · operational authority only</p></div>

        <div aria-live="polite" aria-atomic="true">
          {error && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}
          {success && <Alert className="border-green-500 bg-green-50 dark:bg-green-950"><CheckCircle2 className="h-4 w-4 text-green-600" /><AlertDescription>{success}</AlertDescription></Alert>}
        </div>

        <Card>
          <CardHeader><CardTitle>Authoritative Control State</CardTitle><CardDescription>Server-verified owner read · Redis-backed state</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {systemState ? <>
              <div className="flex items-center justify-between p-4 rounded-lg border"><div><p className="font-medium">Application control</p><p className="text-sm text-muted-foreground">{systemState.killSwitchEnabled ? "Maintenance control active" : "Normal operation"}</p></div><span className={`px-3 py-1 rounded-full text-sm font-medium ${systemState.killSwitchEnabled ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"}`}>{systemState.killSwitchEnabled ? "OFFLINE" : "ONLINE"}</span></div>
              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><div>Revision <span className="font-mono text-foreground">{systemState.revision}</span></div><div>Updated <span className="text-foreground">{new Date(systemState.lastToggleTime).toLocaleString()}</span></div></div>
              {systemState.killSwitchEnabled && systemState.expiresAt && <Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>Emergency control has an explicit 24-hour safety expiry: {new Date(systemState.expiresAt).toLocaleString()}. Deactivate manually when the incident is resolved.</AlertDescription></Alert>}
            </> : <Alert variant="destructive"><AlertDescription>Control state is unknown. Writes are blocked.</AlertDescription></Alert>}
            <Button variant="outline" className="w-full" onClick={() => void fetchSystemState()} disabled={isToggling}><RefreshCw className="h-4 w-4 mr-2" />Refresh canonical state</Button>
          </CardContent>
        </Card>

        <Card className="border-amber-500/50">
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldAlert className="h-5 w-5" />Change justification</CardTitle><CardDescription>Required for every control write and stored in the operational audit trail.</CardDescription></CardHeader>
          <CardContent><label htmlFor="control-reason" className="sr-only">Operational change justification</label><textarea id="control-reason" aria-describedby="control-reason-count" value={reason} onChange={(e) => setReason(e.target.value.slice(0, 240))} disabled={isToggling} maxLength={240} rows={3} placeholder="Why is this operational change necessary?" className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none" /><div id="control-reason-count" className="text-right text-xs text-muted-foreground mt-1">{reason.length}/240</div></CardContent>
        </Card>

        <Card className="border-red-300 dark:border-red-900">
          <CardHeader><CardTitle className="flex items-center gap-2 text-red-600"><Power className="h-5 w-5" />Emergency Kill Switch</CardTitle><CardDescription>High-impact application availability control. It does not alter payment, settlement, refund, Horizon, DB, or accounting truth.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>Every write performs fresh server-side owner verification and rejects a stale control revision. You must type the requested confirmation phrase.</AlertDescription></Alert>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button onClick={() => void executeControl("enable")} disabled={isToggling || !systemState || systemState.killSwitchEnabled || !reason.trim()} variant="destructive" size="lg"><Power className="h-4 w-4 mr-2" />Activate</Button>
              <Button onClick={() => void executeControl("disable")} disabled={isToggling || !systemState || !systemState.killSwitchEnabled || !reason.trim()} variant="outline" size="lg"><CheckCircle2 className="h-4 w-4 mr-2" />Deactivate</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Restore Control Defaults</CardTitle><CardDescription>Restores only the operational control-state record. It does not reset FlashPay, payments, financial records, recovery, or user data.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>This is deliberately not called “System Reset”: its authority is limited to the control-state record.</AlertDescription></Alert><Button onClick={() => void executeControl("reset")} disabled={isToggling || !systemState || !reason.trim()} variant="outline" size="lg" className="w-full">{isToggling ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}Restore Control Defaults</Button></CardContent>
        </Card>

        <div className="text-center text-xs text-muted-foreground"><p>CONTROL PLANE MAY OBSERVE FINANCIAL TRUTH; IT MUST NEVER INVENT OR BYPASS FINANCIAL TRUTH.</p></div>
      </div>
    </main>
    </>
  )
}

export default function ControlPanelPage() { return <ControlPanelContent /> }
