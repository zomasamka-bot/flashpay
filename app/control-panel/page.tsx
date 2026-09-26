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
  const [isDr10Running, setIsDr10Running] = useState(false)
  const [isDr11Running, setIsDr11Running] = useState(false)
  const [dr11RefundId, setDr11RefundId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const writeInFlightRef = useRef(false)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

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
      requestAnimationFrame(() => {
        reasonRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
        reasonRef.current?.focus({ preventScroll: true })
      })
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

  const executeDr10Census = useCallback(async () => {
    if (isDr10Running || !uidData.accessToken) return
    setIsDr10Running(true); setError(null); setSuccess(null)
    try {
      const response = await fetch(`${config.appUrl}/api/control/dr10`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` }, body: JSON.stringify({ confirmation: "CENSUS_ONLY" }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || "DR10 census failed")
      setSuccess(`DR10 census complete · foreign ${data?.result?.foreignKeyCount ?? "?"} · unknown ${data?.result?.unknownForeignKeyCount ?? "?"} · deletion 0`)
    } catch (err) { setError((err as Error)?.message || "DR10 census failed") } finally { setIsDr10Running(false) }
  }, [isDr10Running, uidData.accessToken])

  const executeDr10 = useCallback(async () => {
    if (isDr10Running || !uidData.accessToken) return
    const typed = window.prompt(document.documentElement.lang === "ar" ? "اختبار مدمر لـ Redis فقط. اكتب TOTAL_REDIS_LOSS للمتابعة." : "Destructive Redis-only certification. Type TOTAL_REDIS_LOSS to continue.")
    const confirmation = typed?.trim() ?? ""
    if (confirmation !== "TOTAL_REDIS_LOSS") {
      setSuccess(null)
      setError(typed === null ? "DR10 cancelled before request." : "DR10 confirmation did not match exactly. No request was sent.")
      return
    }
    setIsDr10Running(true); setError(null); setSuccess("DR10 request accepted locally · sending to server…")
    try {
      // DR52: same-origin routing removes appUrl/alias ambiguity from this destructive owner action.
      const response = await fetch("/api/control/dr10", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` }, body: JSON.stringify({ confirmation }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.internalError || data?.error || `DR10 injection failed (${response.status})`)
      setSuccess(`DR10 total Redis loss injected · deleted ${data?.result?.deleted ?? "?"} keys · wait for independent recovery wake`)
    } catch (err) { setSuccess(null); setError((err as Error)?.message || "DR10 injection failed") } finally { setIsDr10Running(false) }
  }, [isDr10Running, uidData.accessToken])

  const armDr11 = useCallback(async () => {
    if (isDr11Running || !uidData.accessToken) return
    const typed = window.prompt(document.documentElement.lang === "ar" ? "تسليح اختبار الاسترداد التالي فقط. اكتب ARM_DR11_NEXT_010_PAYMENT للمتابعة." : "Arm only the next DR11 0.10 payment. Type ARM_DR11_NEXT_010_PAYMENT to continue.")
    if ((typed?.trim() ?? "") !== "ARM_DR11_NEXT_010_PAYMENT") { setError(typed === null ? "DR11 arming cancelled." : "DR11 arming confirmation did not match exactly. No request was sent."); return }
    setIsDr11Running(true); setError(null); setSuccess("Arming one DR11 0.10 Testnet payment for 10 minutes…")
    try {
      const response = await fetch("/api/control/dr11", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` }, body: JSON.stringify({ confirmation: "ARM_DR11_NEXT_010_PAYMENT" }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || `DR11 arm failed (${response.status})`)
      setSuccess(`DR11 armed · exactly one matching 0.10 Testnet payment · TTL ${data?.ttlSeconds ?? 600}s · no financial execution yet`)
    } catch (err) { setSuccess(null); setError((err as Error)?.message || "DR11 arm failed") } finally { setIsDr11Running(false) }
  }, [isDr11Running, uidData.accessToken])

  const resolveDr11 = useCallback(async () => {
    if (isDr11Running || !uidData.accessToken) return
    setIsDr11Running(true); setError(null); setSuccess("Resolving the single pristine DR11 refund authority…")
    try {
      const response = await fetch("/api/control/dr11", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` }, body: JSON.stringify({ confirmation: "RESOLVE_CURRENT" }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || `DR11 resolve failed (${response.status})`)
      const refundId = typeof data?.checkpoint?.refundId === "string" ? data.checkpoint.refundId : ""
      if (!/^[A-Za-z0-9-]{8,128}$/.test(refundId)) throw new Error("DR11 resolver returned an invalid refund ID")
      setDr11RefundId(refundId)
      setSuccess(`DR11 authority resolved · refund ${refundId} · payment ${data?.checkpoint?.paymentId ?? "?"} · financial execution 0`)
    } catch (err) { setSuccess(null); setError((err as Error)?.message || "DR11 resolve failed") } finally { setIsDr11Running(false) }
  }, [isDr11Running, uidData.accessToken])

  const executeDr11 = useCallback(async (live: boolean) => {
    if (isDr11Running || !uidData.accessToken) return
    const refundId = dr11RefundId.trim()
    if (!/^[A-Za-z0-9-]{8,128}$/.test(refundId)) { setError("Enter the exact DR11 refund ID first."); return }
    let confirmation = "READINESS_ONLY"
    if (live) {
      const typed = window.prompt(document.documentElement.lang === "ar" ? "اختبار مالي حي متزامن. اكتب DR11_CONCURRENT_REFUND للمتابعة." : "Live concurrent financial certification. Type DR11_CONCURRENT_REFUND to continue.")
      confirmation = typed?.trim() ?? ""
      if (confirmation !== "DR11_CONCURRENT_REFUND") { setError(typed === null ? "DR11 cancelled before request." : "DR11 confirmation did not match exactly. No request was sent."); return }
    }
    setIsDr11Running(true); setError(null); setSuccess(live ? "DR11 live request accepted locally · sending two bounded contenders…" : "DR11 readiness check running…")
    try {
      const response = await fetch("/api/control/dr11", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` }, body: JSON.stringify({ refundId, confirmation }) })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || `DR11 request failed (${response.status})`)
      setSuccess(live ? `DR11 ${data?.certification ?? "result"} · refund ${data?.final?.refundId ?? refundId} · tx ${data?.final?.refundTxid ?? "?"}` : `DR11 ready · stage ${data?.checkpoint?.stage ?? "?"} · status ${data?.checkpoint?.status ?? "?"} · financial execution 0`)
    } catch (err) { setSuccess(null); setError((err as Error)?.message || "DR11 request failed") } finally { setIsDr11Running(false) }
  }, [isDr11Running, dr11RefundId, uidData.accessToken])

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
          <CardContent><label htmlFor="control-reason" className="sr-only">Operational change justification</label><textarea ref={reasonRef} id="control-reason" aria-describedby="control-reason-count" value={reason} onChange={(e) => setReason(e.target.value.slice(0, 240))} disabled={isToggling} maxLength={240} rows={3} placeholder="Why is this operational change necessary?" className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none" /><div id="control-reason-count" className="text-right text-xs text-muted-foreground mt-1">{reason.length}/240</div></CardContent>
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
          <CardContent className="space-y-4"><Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>This is deliberately not called “System Reset”: its authority is limited to the control-state record.</AlertDescription></Alert><p className="text-xs text-muted-foreground">This control remains available whenever the authoritative state is readable. A justification and RESTORE confirmation are still required before any write.</p><Button onClick={() => void executeControl("reset")} disabled={isToggling || !systemState} variant="outline" size="lg" className="w-full">{isToggling ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}Restore Control Defaults</Button></CardContent>
        </Card>


        <Card className="border-amber-500/50">
          <CardHeader><CardTitle>DR10 Live Total Redis Loss Certification</CardTitle><CardDescription>Owner-only, production-only certification trigger. It deletes Redis projections only after the server-side FlashPay-exclusive keyspace preflight. It does not mutate PostgreSQL or call Pi/Horizon.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>Run the non-destructive census first. It reads only Redis key metadata, never values, and never deletes. The destructive loss trigger remains separately confirmation-gated.</AlertDescription></Alert><Button onClick={() => void executeDr10Census()} disabled={isDr10Running} variant="outline" size="lg" className="w-full">{isDr10Running ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <ShieldAlert className="h-4 w-4 mr-2" />}Run DR10 Safe Census</Button><Button onClick={() => void executeDr10()} disabled={isDr10Running} variant="destructive" size="lg" className="w-full">{isDr10Running ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <ShieldAlert className="h-4 w-4 mr-2" />}Run DR10 Total Redis Loss</Button></CardContent>
        </Card>


        <Card className="border-orange-500/50">
          <CardHeader><CardTitle>DR11 Live Concurrent Refund Certification</CardTitle><CardDescription>Owner-only, production-only, two-contender certification over one exact refund. Readiness is read-only; live execution requires an exact pristine intent_created refund and explicit confirmation.</CardDescription></CardHeader>
          <CardContent className="space-y-4"><Alert><AlertTriangle className="h-4 w-4" /><AlertDescription>First arm exactly one matching 0.10 Pi Testnet payment for 10 minutes. The arm is owner-authenticated, one-shot, and atomically consumed only by the exact DR11 payment gate. Then use the resulting exact refund ID below.</AlertDescription></Alert><Button onClick={() => void armDr11()} disabled={isDr11Running} variant="outline" className="w-full">Arm Next DR11 0.10 Payment</Button><Button onClick={() => void resolveDr11()} disabled={isDr11Running} variant="outline" className="w-full">Load Current DR11 Refund</Button><input value={dr11RefundId} onChange={(e) => setDr11RefundId(e.target.value.slice(0,128))} disabled={isDr11Running} placeholder="Exact DR11 refund ID" className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono" /><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><Button onClick={() => void executeDr11(false)} disabled={isDr11Running || !dr11RefundId.trim()} variant="outline">Check DR11 Readiness</Button><Button onClick={() => void executeDr11(true)} disabled={isDr11Running || !dr11RefundId.trim()} variant="destructive">Run DR11 Concurrent Refund</Button></div></CardContent>
        </Card>

        <div className="text-center text-xs text-muted-foreground"><p>CONTROL PLANE MAY OBSERVE FINANCIAL TRUTH; IT MUST NEVER INVENT OR BYPASS FINANCIAL TRUTH.</p></div>
      </div>
    </main>
    </>
  )
}

export default function ControlPanelPage() { return <ControlPanelContent /> }
