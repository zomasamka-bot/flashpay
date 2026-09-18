"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle, RefreshCw, Server, Smartphone, Stethoscope } from "lucide-react"
import { BackButton } from "@/components/back-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { config } from "@/lib/config"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { useI18n } from "@/components/i18n-provider"
import { translateUpperOperationsText } from "@/components/upper-operations-arabic-layer"

type Status = "pass" | "warn" | "fail" | "unknown"
type Check = { status: Status; detail: string; latencyMs?: number; observedAt?: string; ageMs?: number }
type InfrastructureHealth = { overall: Status; asOf: string; checks: Record<string, Check> }
type DeviceCheck = { name: string; status: "pass" | "warn" | "fail"; message: string }

const labels: Record<string, string> = {
  postgres: "PostgreSQL",
  redis: "Redis",
  piApi: "Pi Server API",
  horizon: "Pi Testnet Horizon",
  recoveryWake: "Recovery Wake Freshness",
  canonicalStorage: "Canonical Storage",
}

function statusClasses(status: Status) {
  if (status === "pass") return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200"
  if (status === "warn" || status === "unknown") return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200"
  return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200"
}

export default function DiagnosticsPage() {
  const { locale } = useI18n()
  const tr = (value: string) => translateUpperOperationsText(locale, value)
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const [mounted, setMounted] = useState(false)
  const [health, setHealth] = useState<InfrastructureHealth | null>(null)
  const [deviceChecks, setDeviceChecks] = useState<DeviceCheck[]>([])
  const [loading, setLoading] = useState(false)
  const [serverError, setServerError] = useState(false)

  useEffect(() => setMounted(true), [])
  useEffect(() => { if (mounted && uidData.status === "success" && uidData.uid !== config.ownerUid) router.push("/") }, [mounted, uidData.status, uidData.uid, router])

  const runDeviceDiagnostics = () => {
    const results: DeviceCheck[] = []
    results.push({ name: "Pi SDK", status: typeof window !== "undefined" && !!(window as any).Pi ? "pass" : "fail", message: typeof window !== "undefined" && !!(window as any).Pi ? "Pi SDK is available" : "Pi SDK not detected" })
    let local: DeviceCheck = { name: "Local Storage", status: "pass", message: "Local Storage is accessible" }
    try { localStorage.setItem("__diagnostic_test", "ok"); localStorage.removeItem("__diagnostic_test") } catch { local = { name: "Local Storage", status: "warn", message: "Local Storage is restricted" } }
    results.push(local)
    results.push({ name: "Network", status: navigator.onLine ? "pass" : "warn", message: navigator.onLine ? "Browser reports online" : "Browser reports offline" })
    results.push({ name: "DOM", status: document.readyState === "complete" || document.readyState === "interactive" ? "pass" : "warn", message: `Document state: ${document.readyState}` })
    setDeviceChecks(results)
  }

  const runServerDiagnostics = async () => {
    if (!uidData.accessToken) return
    setLoading(true); setServerError(false)
    try {
      const response = await fetch("/api/operations/infrastructure-health", { headers: { Authorization: `Bearer ${uidData.accessToken}` }, cache: "no-store" })
      const data = await response.json()
      if (!response.ok || !data?.checks || typeof data?.asOf !== "string") throw new Error("Infrastructure health unavailable")
      setHealth(data)
    } catch (error) {
      console.error("[diagnostics] infrastructure health failed", error)
      setHealth(null); setServerError(true)
    } finally { setLoading(false) }
  }

  useEffect(() => { if (mounted) runDeviceDiagnostics() }, [mounted])
  useEffect(() => { if (uidData.status === "success" && uidData.uid === config.ownerUid && uidData.accessToken) void runServerDiagnostics() }, [uidData.status, uidData.uid, uidData.accessToken])

  if (!mounted) return null
  const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid
  if (!isOwner) return null

  return <div className="min-h-screen pb-20 pt-4"><div className="max-w-4xl mx-auto px-4 space-y-6">
    <div className="flex items-center gap-3"><BackButton /><div><div className="flex items-center gap-2"><Stethoscope className="h-6 w-6 text-blue-600"/><h1 className="text-2xl font-bold">{tr('System Diagnostics')}</h1></div><p className="text-sm text-muted-foreground">{tr("Server-backed platform health with secondary device diagnostics")}</p></div></div>

    <Card className="border-blue-500/40"><CardHeader><CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Server className="h-5 w-5"/>{tr('Infrastructure Health')}</span><Button size="sm" variant="outline" onClick={() => void runServerDiagnostics()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}/> {tr("Re-run")}</Button></CardTitle><CardDescription>{tr('Owner-authenticated, read-only checks. Unknown is never reported as healthy.')}</CardDescription></CardHeader><CardContent className="space-y-3">
      {serverError ? <div className="p-4 rounded-lg border border-red-300 text-red-700">{tr('Infrastructure diagnostics unavailable. No healthy state is inferred.')}</div> : Object.entries(health?.checks ?? {}).map(([key, check]) => <div key={key} className={`p-4 border rounded-lg ${statusClasses(check.status)}`}><div className="flex items-start justify-between gap-3"><div className="flex gap-3">{check.status === "pass" ? <CheckCircle className="h-4 w-4 mt-0.5"/> : <AlertCircle className="h-4 w-4 mt-0.5"/>}<div><div className="font-semibold text-sm">{labels[key] ?? key}</div><div className="text-xs opacity-80 mt-1">{check.detail}</div>{typeof check.latencyMs === "number" && <div className="text-xs opacity-60 mt-1">{check.latencyMs} ms</div>}{check.observedAt && <div className="text-xs opacity-60 mt-1">{tr("Observed:")} {new Date(check.observedAt).toLocaleString()}</div>}</div></div><Badge className="capitalize">{check.status}</Badge></div></div>)}
      <div className="text-xs text-muted-foreground">{loading ? tr("Checking authoritative dependencies…") : health ? `${tr("Overall:")} ${tr(health.overall.toUpperCase())} · ${tr("as of")} ${new Date(health.asOf).toLocaleString()}` : tr("Waiting for server diagnostics…")}</div>
    </CardContent></Card>

    <Card><CardHeader><CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Smartphone className="h-5 w-5"/>{tr('Device Diagnostics')}</span><Button size="sm" variant="outline" onClick={runDeviceDiagnostics}><RefreshCw className="h-4 w-4"/> {tr("Re-run")}</Button></CardTitle><CardDescription>{tr('Browser/device checks only; these do not prove platform or financial health.')}</CardDescription></CardHeader><CardContent className="space-y-3">{deviceChecks.map(check => <div key={check.name} className={`p-4 border rounded-lg ${statusClasses(check.status)}`}><div className="flex items-start justify-between gap-3"><div><div className="font-semibold text-sm">{check.name}</div><div className="text-xs opacity-80 mt-1">{check.message}</div></div><Badge className="capitalize">{check.status}</Badge></div></div>)}</CardContent></Card>
  </div></div>
}
