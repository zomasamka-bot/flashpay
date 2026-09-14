"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, RefreshCw, ShoppingBag } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
  nextOffset: number | null
}

interface LocalDayWindow {
  dateKey: string
  from: string
  to: string
  label: string
  dateLabel: string
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseLocalDateKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) return null
  return parsed
}

function getLocalDayWindow(dateKey: string): LocalDayWindow | null {
  const start = parseLocalDateKey(dateKey)
  if (!start) return null
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0)
  return {
    dateKey,
    from: start.toISOString(),
    to: end.toISOString(),
    label: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(start),
    dateLabel: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(start),
  }
}

function shiftLocalDateKey(dateKey: string, days: number): string | null {
  const date = parseLocalDateKey(dateKey)
  if (!date || !Number.isInteger(days)) return null
  const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0)
  return toLocalDateKey(shifted)
}

function isSalesDay(value: unknown): value is SalesDay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const day = value as Record<string, unknown>
  if (typeof day.from !== "string" || typeof day.to !== "string") return false
  if (typeof day.totalSales !== "number" || !Number.isFinite(day.totalSales) || day.totalSales < 0) return false
  if (typeof day.successfulSalesCount !== "number" || !Number.isInteger(day.successfulSalesCount) || day.successfulSalesCount < 0) return false
  if (typeof day.processingCount !== "number" || !Number.isInteger(day.processingCount) || day.processingCount < 0) return false
  if (typeof day.hasMore !== "boolean" || !Array.isArray(day.timeline)) return false
  if (day.nextOffset !== null && (!Number.isSafeInteger(day.nextOffset) || (day.nextOffset as number) < 0)) return false
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
  const todayKey = useMemo(() => toLocalDateKey(new Date()), [])
  const [selectedDate, setSelectedDate] = useState(todayKey)
  const dayWindow = useMemo(() => getLocalDayWindow(selectedDate), [selectedDate])
  const [day, setDay] = useState<SalesDay | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchSalesPage = useCallback(async (offset: number, signal?: AbortSignal): Promise<SalesDay> => {
    if (!merchant.merchantId || !merchant.accessToken) throw new Error("Merchant authentication required")
    if (!dayWindow) throw new Error("Invalid sales date")

    const params = new URLSearchParams({
      merchantId: merchant.merchantId,
      view: "sales",
      from: dayWindow.from,
      to: dayWindow.to,
      offset: String(offset),
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
    if (candidate.from !== dayWindow.from || candidate.to !== dayWindow.to) throw new Error("Sales date mismatch")
    return candidate
  }, [dayWindow, merchant.accessToken, merchant.merchantId])

  const loadSales = useCallback(async (signal?: AbortSignal) => {
    if (!merchant.merchantId || !merchant.accessToken) {
      setDay(null)
      setError(null)
      setLoading(false)
      return
    }
    if (!dayWindow) {
      setDay(null)
      setError("Invalid sales date")
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const firstPage = await fetchSalesPage(0, signal)
      setDay(firstPage)
    } catch (loadError) {
      if (signal?.aborted) return
      setDay(null)
      setError(loadError instanceof Error ? loadError.message : "Sales unavailable")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [dayWindow, fetchSalesPage, merchant.accessToken, merchant.merchantId])

  const loadMore = async () => {
    if (!day?.hasMore || day.nextOffset === null || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const nextPage = await fetchSalesPage(day.nextOffset)
      setDay((current) => {
        if (!current || current.from !== nextPage.from || current.to !== nextPage.to) return current
        return {
          ...nextPage,
          timeline: [...current.timeline, ...nextPage.timeline],
        }
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load more sales")
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void loadSales(controller.signal)
    return () => controller.abort()
  }, [loadSales])

  const isToday = selectedDate === todayKey
  const previousDate = shiftLocalDateKey(selectedDate, -1)
  const nextDate = shiftLocalDateKey(selectedDate, 1)
  const canGoNext = nextDate !== null && nextDate <= todayKey

  const selectDate = (dateKey: string) => {
    if (!getLocalDayWindow(dateKey) || dateKey > todayKey) return
    setSelectedDate(dateKey)
  }

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
              <span>{dayWindow ? `${dayWindow.label}, ${dayWindow.dateLabel}` : "Invalid date"}</span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadSales()}
            disabled={loading || !merchant.merchantId || !merchant.accessToken || !dayWindow}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card>
          <CardContent className="pt-6">
            <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={!previousDate || loading}
                onClick={() => previousDate && selectDate(previousDate)}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous day
              </Button>
              <div className="space-y-1.5">
                <label htmlFor="sales-date" className="text-xs font-medium text-muted-foreground">Sales date</label>
                <Input
                  id="sales-date"
                  type="date"
                  value={selectedDate}
                  max={todayKey}
                  onChange={(event) => selectDate(event.target.value)}
                  disabled={loading}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={!canGoNext || loading}
                onClick={() => nextDate && canGoNext && selectDate(nextDate)}
              >
                Next day
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            {!isToday && (
              <Button type="button" variant="ghost" size="sm" className="mt-3" disabled={loading} onClick={() => selectDate(todayKey)}>
                Back to Today
              </Button>
            )}
            <p className="mt-2 text-xs text-muted-foreground">Day boundaries follow this device&apos;s local time; the server receives the exact UTC window for that local calendar day.</p>
          </CardContent>
        </Card>

        {!merchant.merchantId || !merchant.accessToken ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Connect your Pi merchant account from Home to view sales.
            </CardContent>
          </Card>
        ) : error && !day ? (
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
                  <CardDescription>{isToday ? "Today's Sales" : "Sales"}</CardDescription>
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
                <CardTitle>{isToday ? "Today's Activity" : "Sales Activity"}</CardTitle>
                <CardDescription>Server-authoritative merchant sales timeline for the selected local day</CardDescription>
              </CardHeader>
              <CardContent>
                {loading && !day ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">Loading sales...</p>
                ) : !day || day.timeline.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No sales activity for this day.</p>
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
                {error && day && <p className="mt-3 text-sm text-destructive">{error}</p>}
                {day?.hasMore && (
                  <div className="mt-4 border-t pt-4 text-center">
                    <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? "Loading..." : "Load more"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
