"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { CalendarDays, CheckCircle2, Clock, RefreshCw, ShoppingBag } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { config } from "@/lib/config"
import { useMerchant } from "@/lib/use-merchant"

type SalesStatus = "paid" | "processing" | "failed" | "cancelled" | "needs_attention"

interface SalesTimelineItem {
  occurredAt: string
  customerName: string | null
  amount: number
  status: SalesStatus
}

interface SalesDay {
  from: string
  to: string
  totalSales: number
  successfulSalesCount: number
  processingCount: number
  timeline: SalesTimelineItem[]
  hasMore: boolean
}

function getLocalDayWindow(): { from: string; to: string; label: string; dateLabel: string } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    label: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(now),
    dateLabel: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(now),
  }
}

function isSalesDay(value: unknown): value is SalesDay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const day = value as Record<string, unknown>
  if (typeof day.from !== "string" || typeof day.to !== "string") return false
  if (typeof day.totalSales !== "number" || !Number.isFinite(day.totalSales) || day.totalSales < 0) return false
  if (typeof day.successfulSalesCount !== "number" || !Number.isInteger(day.successfulSalesCount) || day.successfulSalesCount < 0) return false
  if (typeof day.processingCount !== "number" || !Number.isInteger(day.processingCount) || day.processingCount < 0) return false
  if (typeof day.hasMore !== "boolean" || !Array.isArray(day.timeline)) return false
  return day.timeline.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    return (
      typeof row.occurredAt === "string" && Number.isFinite(Date.parse(row.occurredAt)) &&
      (row.customerName === null || typeof row.customerName === "string") &&
      typeof row.amount === "number" && Number.isFinite(row.amount) && row.amount > 0 &&
      ["paid", "processing", "failed", "cancelled", "needs_attention"].includes(String(row.status))
    )
  })
}

const STATUS_LABEL: Record<SalesStatus, string> = {
  paid: "Paid",
  processing: "Processing",
  failed: "Failed",
  cancelled: "Cancelled",
  needs_attention: "Needs attention",
}

export default function PaymentsPage() {
  const merchant = useMerchant()
  const dayWindow = useMemo(() => getLocalDayWindow(), [])
  const [day, setDay] = useState<SalesDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSales = useCallback(async (signal?: AbortSignal) => {
    if (!merchant.merchantId || !merchant.accessToken) {
      setDay(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        merchantId: merchant.merchantId,
        view: "sales",
        from: dayWindow.from,
        to: dayWindow.to,
      })
      const response = await fetch(`${config.appUrl}/api/merchant/payments?${params.toString()}`, {
        headers: { Authorization: `Bearer ${merchant.accessToken}` },
        cache: "no-store",
        signal,
      })
      if (!response.ok) throw new Error(`Sales unavailable (${response.status})`)
      const payload: unknown = await response.json()
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid sales response")
      const candidate = (payload as Record<string, unknown>).day
      if (!isSalesDay(candidate)) throw new Error("Invalid sales response")
      setDay(candidate)
    } catch (loadError) {
      if (signal?.aborted) return
      setDay(null)
      setError(loadError instanceof Error ? loadError.message : "Sales unavailable")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [dayWindow.from, dayWindow.to, merchant.accessToken, merchant.merchantId])

  useEffect(() => {
    const controller = new AbortController()
    void loadSales(controller.signal)
    return () => controller.abort()
  }, [loadSales])

  return (
    <div className="min-h-screen pb-24 pt-4">
      <div className="mx-auto max-w-3xl space-y-5 px-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShoppingBag className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Sales</h1>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              <span>{dayWindow.label}, {dayWindow.dateLabel}</span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadSales()}
            disabled={loading || !merchant.merchantId || !merchant.accessToken}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {!merchant.merchantId || !merchant.accessToken ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Connect your Pi merchant account from Home to view sales.
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button type="button" variant="outline" className="mt-4" onClick={() => void loadSales()}>Try again</Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Today&apos;s Sales</CardDescription>
                  <CardTitle className="text-3xl">{day ? `${day.totalSales.toFixed(2)}π` : "—"}</CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Successful Sales</CardDescription>
                  <CardTitle className="flex items-center gap-2 text-3xl">
                    <CheckCircle2 className="h-5 w-5 text-green-700" />
                    {day?.successfulSalesCount ?? "—"}
                  </CardTitle>
                </CardHeader>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription>Processing</CardDescription>
                  <CardTitle className="flex items-center gap-2 text-3xl">
                    <Clock className="h-5 w-5 text-amber-700" />
                    {day?.processingCount ?? "—"}
                  </CardTitle>
                </CardHeader>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Today&apos;s Activity</CardTitle>
                <CardDescription>Server-authoritative merchant sales timeline</CardDescription>
              </CardHeader>
              <CardContent>
                {loading && !day ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">Loading today&apos;s sales...</p>
                ) : !day || day.timeline.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No sales activity today.</p>
                ) : (
                  <div className="divide-y">
                    {day.timeline.map((item, index) => (
                      <div key={`${item.occurredAt}-${index}`} className="flex items-center gap-3 py-3">
                        <div className="w-16 shrink-0 text-sm font-medium tabular-nums">
                          {new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(item.occurredAt))}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{item.customerName ? `@${item.customerName}` : "Name unavailable"}</p>
                          <p className="text-xs text-muted-foreground">{STATUS_LABEL[item.status]}</p>
                        </div>
                        <div className="shrink-0 text-right font-semibold tabular-nums">{item.amount.toFixed(2)}π</div>
                      </div>
                    ))}
                  </div>
                )}
                {day?.hasMore && (
                  <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">More activity exists for this day. Full history navigation is added in K9.</p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
