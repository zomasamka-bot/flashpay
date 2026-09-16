/**
 * Domain Management - Operations Console
 * M13 Step 2: server-authoritative FlashPay domain availability control.
 * Master Lock remains unchanged until Step 3.
 */

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Globe, Lock, Unlock, ExternalLink, RefreshCw } from "lucide-react"
import { useDomains } from "@/lib/domains"
import { useOwnerUid } from "@/lib/use-owner-uid"
import type { DomainControlState } from "@/lib/domain-control"

export default function DomainsPage() {
  const router = useRouter()
  const { domains, masterEnabled } = useDomains()
  const { uidData } = useOwnerUid()
  const [mounted, setMounted] = useState(false)
  const [domainState, setDomainState] = useState<DomainControlState | null>(null)
  const [loading, setLoading] = useState(true)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writeRef = useRef(false)

  useEffect(() => setMounted(true), [])

  const loadDomainState = useCallback(async () => {
    if (!uidData.accessToken) { setLoading(false); setError("Owner authorization is required to read domain state."); return }
    setLoading(true)
    try {
      setError(null)
      const response = await fetch("/api/control/domain", { headers: { Authorization: `Bearer ${uidData.accessToken}` }, cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || "Domain state unavailable")
      setDomainState(data as DomainControlState)
    } catch (e) { setDomainState(null); setError((e as Error).message || "Domain state unavailable") }
    finally { setLoading(false) }
  }, [uidData.accessToken])

  useEffect(() => { if (mounted) void loadDomainState() }, [mounted, loadDomainState])

  const changeFlashPay = useCallback(async (enabled: boolean) => {
    if (writeRef.current || !domainState || !uidData.accessToken) return
    const phrase = enabled ? "ENABLE" : "DISABLE"
    const typed = window.prompt(document.documentElement.lang === "ar" ? `تحكم نطاق عالي التأثير. اكتب ${phrase} للمتابعة.` : `High-impact domain control. Type ${phrase} to continue.`)
    if (typed !== phrase) return
    writeRef.current = true; setChanging(true); setError(null)
    try {
      const response = await fetch("/api/control/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${uidData.accessToken}` },
        body: JSON.stringify({ enabled, expectedRevision: domainState.revision }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (response.status === 409 && data?.state) setDomainState(data.state)
        throw new Error(data?.error || "Domain control change failed")
      }
      setDomainState(data.state)
    } catch (e) { setError((e as Error).message || "Domain control change failed") }
    finally { await loadDomainState(); writeRef.current = false; setChanging(false) }
  }, [domainState, uidData.accessToken, loadDomainState])

  if (!mounted) return null
  const integrationDomains = domains.filter((d) => !d.isPrimary)
  const flashPayEnabled = domainState?.flashpayEnabled ?? false

  return (
    <div className="min-h-screen pb-6 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        <div className="mb-2"><h1 className="text-3xl font-bold">Domain Management</h1><p className="text-sm text-muted-foreground mt-1">Configure integration domains and access controls</p></div>
        <Card className="border-2 border-primary"><CardHeader><CardTitle className="flex items-center justify-between"><div className="flex items-center gap-2"><Lock className="h-5 w-5" />Master Lock</div><Badge variant={masterEnabled ? "default" : "secondary"}>{masterEnabled ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}{masterEnabled ? "Unlocked" : "Locked"}</Badge></CardTitle><CardDescription>Master lock is unchanged in Step 2. Its authoritative upgrade is Step 3.</CardDescription></CardHeader></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Globe className="h-5 w-5" />Domains</CardTitle><CardDescription>Server-authoritative availability · Redis-backed · owner verified</CardDescription></CardHeader><CardContent><div className="space-y-3">
          {error && <div className="rounded-md border border-destructive/50 p-3 text-sm text-destructive" role="alert">{error}</div>}
          {domains.map((domain) => {
            const enabled = domain.id === "flashpay" ? flashPayEnabled : domain.enabled
            return <div key={domain.id} className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-lg border ${domain.isPrimary ? "bg-primary/5 border-primary/20" : "bg-muted/50"}`}>
              <div className="flex items-center gap-4 min-w-0"><div className={`h-3 w-3 rounded-full flex-shrink-0 ${enabled ? "bg-green-600" : "bg-muted-foreground"}`} /><div className="min-w-0"><div className="flex items-center gap-2"><span className="font-medium">{domain.name}</span>{domain.isPrimary && <Badge variant="secondary" className="text-xs">Primary</Badge>}</div><p className="text-xs text-muted-foreground font-mono mt-1 break-all">{domain.domain}</p>{domain.description && <p className="text-xs text-muted-foreground mt-1">{domain.description}</p>}{domain.id === "flashpay" && domainState && <p className="text-[11px] text-muted-foreground mt-1">Revision {domainState.revision} · {new Date(domainState.updatedAt).toLocaleString()}</p>}</div></div>
              <div className="flex items-center gap-2 self-end sm:self-auto"><Badge variant={enabled ? "default" : "outline"}>{loading ? "Loading" : enabled ? "Active" : "Inactive"}</Badge>{domain.id === "flashpay" && <Button onClick={() => void changeFlashPay(!enabled)} disabled={loading || changing || !domainState} size="sm" variant={enabled ? "outline" : "default"} aria-label={enabled ? "Disable FlashPay domain" : "Enable FlashPay domain"}>{changing ? <RefreshCw className="h-4 w-4 animate-spin" /> : enabled ? "Disable" : "Enable"}</Button>}{domain.routes?.length > 0 && <Button onClick={() => router.push(domain.routes[0])} size="sm" variant="ghost" disabled={!enabled}><ExternalLink className="h-4 w-4" /></Button>}</div>
            </div>
          })}
        </div></CardContent></Card>
        {integrationDomains.length > 0 && <Card><CardHeader><CardTitle className="flex items-center gap-2"><ExternalLink className="h-5 w-5" />Integration Domain Pages ({integrationDomains.length})</CardTitle><CardDescription>Access domain-specific operational pages</CardDescription></CardHeader></Card>}
      </div>
    </div>
  )
}
