"use client"

import { FormEvent, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, Search, ShieldCheck } from "lucide-react"
import { BackButton } from "@/components/back-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { config } from "@/lib/config"
import { useOwnerUid } from "@/lib/use-owner-uid"

type Review = {
  paymentId: string; verdict: "Final" | "Recovering" | "Manual Review" | "Conflict" | "Unknown"; reason: string; asOf: string
  canonical: Record<string, unknown>; database: Record<string, unknown>; refund: Record<string, unknown>
  action: { allowed: false; message: string }
}

export default function EmergencyPage() {
  const { uidData } = useOwnerUid()
  const [mounted, setMounted] = useState(false)
  const [paymentId, setPaymentId] = useState("")
  const [review, setReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => setMounted(true), [])

  const inspect = async (event: FormEvent) => {
    event.preventDefault(); setReview(null); setError("")
    const id = paymentId.trim()
    if (!id || uidData.status !== "success" || uidData.uid !== config.ownerUid || !uidData.accessToken) { setError("Owner authentication and a valid Payment ID are required."); return }
    setLoading(true)
    try {
      const response = await fetch(`/api/operations/payment-review?paymentId=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${uidData.accessToken}` }, cache: "no-store" })
      const data = await response.json()
      if (!response.ok && !data?.verdict) throw new Error(data?.error || "Review unavailable")
      setReview(data)
    } catch (e) { setError(e instanceof Error ? e.message : "Review unavailable") }
    finally { setLoading(false) }
  }

  if (!mounted) return null
  const entries = review ? Object.entries(review.canonical).filter(([, value]) => value !== null && value !== undefined) : []
  const badgeClass = review?.verdict === "Final" ? "bg-green-600" : review?.verdict === "Recovering" ? "bg-blue-600" : review?.verdict === "Conflict" ? "bg-red-600" : "bg-amber-600"

  return <div className="min-h-screen bg-background p-4"><div className="mx-auto max-w-2xl space-y-5">
    <BackButton />
    <div><h1 className="text-3xl font-bold">Recovery & Manual Review</h1><p className="mt-1 text-muted-foreground">Owner-only evidence workbench. Read-only by design.</p></div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Search className="h-5 w-5"/>Inspect Payment</CardTitle><CardDescription>Enter the exact FlashPay Payment ID. Unknown or conflicting evidence never enables an action.</CardDescription></CardHeader><CardContent>
      <form onSubmit={inspect} className="flex gap-2"><input aria-label="Payment ID" value={paymentId} onChange={e=>setPaymentId(e.target.value)} placeholder="Payment ID" className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm"/><Button type="submit" disabled={loading}>{loading?<Loader2 className="h-4 w-4 animate-spin"/>:"Inspect"}</Button></form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </CardContent></Card>
    {review && <>
      <Card className={review.verdict === "Conflict" ? "border-red-400" : "border-amber-300"}><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle className="flex items-center gap-2">{review.verdict === "Final"?<CheckCircle2 className="h-5 w-5"/>:<AlertTriangle className="h-5 w-5"/>}Verdict</CardTitle><Badge className={badgeClass}>{review.verdict}</Badge></div><CardDescription>{review.reason}</CardDescription></CardHeader><CardContent className="text-xs text-muted-foreground">As of {new Date(review.asOf).toLocaleString()}</CardContent></Card>
      <Card><CardHeader><CardTitle>Canonical Payment Evidence</CardTitle></CardHeader><CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-2">{entries.map(([key,value])=><div key={key} className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{key}</div><div className="break-all font-mono text-sm">{String(value)}</div></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>Cross-checks</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><div className="rounded-md border p-3">Database: <strong>{String(review.database.state)}</strong>{typeof review.database.transactionCount === "number"?` · transactions ${review.database.transactionCount} · receipts ${review.database.receiptCount}`:""}</div><div className="rounded-md border p-3">Refund checkpoint: <strong>{String(review.refund.state)}</strong>{review.refund.status?` · ${String(review.refund.status)} / ${String(review.refund.stage)}`:""}</div></CardContent></Card>
      <Card className="border-blue-300"><CardContent className="flex gap-3 pt-6"><ShieldCheck className="h-5 w-5 shrink-0 text-blue-600"/><p className="text-sm">{review.action.message}</p></CardContent></Card>
    </>}
  </div></div>
}
