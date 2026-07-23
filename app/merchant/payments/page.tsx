"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { BackButton } from "@/components/back-button"
import { Spinner } from "@/components/ui/spinner"
import { useMerchant } from "@/lib/use-merchant"
import { config } from "@/lib/config"

import { Calendar, Search, Download, ChevronRight, TrendingUp, Filter } from "lucide-react"

interface MerchantPayment {
  id: string
  transactionId: string
  paymentId: string
  merchantId: string
  reference: string
  note: string
  status: string
  paymentStatus: string
  createdAt: string
  amount: number
  settlementStatus: string | null
  completedAt: string | null
  piPaymentId: string | null
  u2aTxid: string | null
  a2uPaymentId: string | null
  a2uTxid: string | null
}

interface MerchantDashboardSummary {
  total_requests: number
  total_payment_volume: number
  settled_transactions: number
  total_settled_amount: number
  pending_transactions: number
  total_awaiting_amount: number
  failed_transactions: number
}

export default function MerchantPaymentsPage() {
  const router = useRouter()
  const merchant = useMerchant()

  type PaymentStatusFilter = "all" | "pending" | "failed" | "cancelled" | "paid_to_app" | "settlement_pending" | "settled_to_merchant" | "settlement_failed"

  const isValidPaymentStatusFilter = (value: unknown): value is PaymentStatusFilter => {
    const validStatuses: PaymentStatusFilter[] = [
      "all",
      "pending",
      "failed",
      "cancelled",
      "paid_to_app",
      "settlement_pending",
      "settled_to_merchant",
      "settlement_failed",
    ]
    return typeof value === "string" && validStatuses.includes(value as PaymentStatusFilter)
  }

  const [payments, setPayments] = useState<MerchantPayment[]>([])
  const [summary, setSummary] = useState<MerchantDashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterStatus, setFilterStatus] = useState<PaymentStatusFilter>("all")
  const [filterDateFrom, setFilterDateFrom] = useState("")
  const [filterDateTo, setFilterDateTo] = useState("")
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    const fetchPayments = async () => {
      // Missing ID or token: clear and return
      if (!merchant?.merchantId || !merchant?.accessToken) {
        setPayments([])
        setSummary(null)
        setError(null)
        setLoading(false)
        return
      }

      // Invalid date range: clear payments, keep summary, set error
      if (filterDateFrom && filterDateTo && filterDateFrom > filterDateTo) {
        setPayments([])
        setError("From date must be on or before To date")
        setLoading(false)
        return
      }

      // Clear stale data and set loading
      setPayments([])
      setSummary(null)
      setError(null)
      setLoading(true)

      try {
        const params = new URLSearchParams({
          merchantId: merchant.merchantId,
          limit: "100",
        })

        if (filterDateFrom) params.append("fromDate", filterDateFrom)
        if (filterDateTo) params.append("toDate", filterDateTo)

        const response = await fetch(`${config.appUrl}/api/merchant/payments?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${merchant.accessToken}`,
          },
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        if (!response.ok) {
          setPayments([])
          setSummary(null)
          setError(`Failed to load payments: ${response.statusText}`)
          return
        }

        const data = await response.json()

        if (controller.signal.aborted) return

        // Validate data structure
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          setPayments([])
          setSummary(null)
          setError("Invalid dashboard data format")
          return
        }

        if (!Array.isArray(data.payments)) {
          setPayments([])
          setSummary(null)
          setError("Invalid dashboard data format")
          return
        }

        if (typeof data.summary !== "object" || data.summary === null || Array.isArray(data.summary)) {
          setPayments([])
          setSummary(null)
          setError("Invalid dashboard data format")
          return
        }

        const summary = data.summary as Record<string, unknown>

        // Validate count fields (non-negative integers)
        for (const field of ["total_requests", "settled_transactions", "pending_transactions", "failed_transactions"]) {
          const value = summary[field]
          if (!Number.isInteger(value) || (value as number) < 0) {
            setPayments([])
            setSummary(null)
            setError("Invalid dashboard data format")
            return
          }
        }

        // Validate amount fields (finite non-negative numbers)
        for (const field of ["total_payment_volume", "total_settled_amount", "total_awaiting_amount"]) {
          const value = summary[field]
          if (typeof value !== "number" || !isFinite(value) || (value as number) < 0) {
            setPayments([])
            setSummary(null)
            setError("Invalid dashboard data format")
            return
          }
        }

        setPayments(data.payments)
        setSummary(data.summary)
        setError(null)
      } catch (err) {
        if (controller.signal.aborted) return

        console.error("[Merchant Payments] Error fetching payments:", err)
        setPayments([])
        setSummary(null)
        setError(err instanceof Error ? err.message : "Failed to load payments")
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    fetchPayments()
    return () => controller.abort()
  }, [merchant?.merchantId, merchant?.accessToken, filterDateFrom, filterDateTo])

  const filteredPayments = payments.filter((p) => {
    const searchLower = searchQuery.trim().toLowerCase()
    const matchesSearch =
      p.id.toLowerCase().includes(searchLower) ||
      p.transactionId.toLowerCase().includes(searchLower) ||
      p.paymentId.toLowerCase().includes(searchLower) ||
      p.reference.toLowerCase().includes(searchLower) ||
      p.note.toLowerCase().includes(searchLower)
    const matchesStatus = filterStatus === "all" || p.status.toLowerCase() === filterStatus
    return matchesSearch && matchesStatus
  })

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "settled_to_merchant":
        return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
      case "paid_to_app":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
      case "settlement_pending":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
      case "settlement_failed":
        return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
      case "failed":
        return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
      case "pending":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
      case "cancelled":
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400"
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400"
    }
  }

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    } catch {
      return dateStr
    }
  }

  const formatCSVCell = (value: unknown): string => {
    let str = value == null ? "" : String(value)
    // Escape formulas by prefixing with single quote
    if (/^[=+\-@]/.test(str.trimStart())) {
      str = "'" + str
    }
    // Escape double quotes by doubling them
    str = str.replace(/"/g, '""')
    // Always quote the cell
    return '"' + str + '"'
  }

  const exportToCSV = async () => {
    try {
      setExportError(null)

      if (filteredPayments.length === 0) {
        setExportError("No payments to export")
        return
      }

      setExporting(true)

      const headers = [
        "Reference",
        "Transaction ID",
        "Payment ID",
        "Amount (π)",
        "Status",
        "Note",
        "Created",
        "Completed",
        "Pi Payment ID",
        "U2A TXID",
        "A2U Payment ID",
        "A2U TXID",
      ]

      const rows = filteredPayments.map((p) => [
        p.reference,
        p.transactionId,
        p.paymentId,
        p.amount.toFixed(2),
        p.status,
        p.note,
        p.createdAt,
        p.completedAt || "",
        p.piPaymentId || "",
        p.u2aTxid || "",
        p.a2uPaymentId || "",
        p.a2uTxid || "",
      ])

      const headerRow = headers.map(formatCSVCell).join(",")
      const bodyRows = rows.map((row) => row.map(formatCSVCell).join(",")).join("\r\n")
      const csvContent = headerRow + "\r\n" + bodyRows

      // Add UTF-8 BOM
      const bomContent = "\ufeff" + csvContent
      const filename = `payments-export-${new Date().toISOString().split("T")[0]}.csv`
      const file = new File([bomContent], filename, { type: "text/csv;charset=utf-8" })

      // Try navigator.share if available
      if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true) {
        await navigator.share({
          files: [file],
        })
      } else {
        // Fallback: use hidden anchor
        const url = URL.createObjectURL(file)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.style.display = "none"
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (err) {
      if (err && typeof err === "object" && (err as any).name === "AbortError") {
        // User cancelled share, silently ignore
        return
      }
      setExportError("CSV export failed")
      console.error("[Merchant Payments] CSV export error:", err)
    } finally {
      setExporting(false)
    }
  }

  if (!merchant?.merchantId) {
    return (
      <main className="flex-1 flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-muted-foreground">Please authenticate to view payments</p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex-1 pb-20 pt-4 px-4 md:px-8">
      <BackButton />

      <div className="max-w-6xl mx-auto space-y-6 mt-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            <h1 className="text-3xl font-bold">Payment Dashboard</h1>
          </div>
          <p className="text-muted-foreground">Track payments and settlements</p>
        </div>

        <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">All-time Merchant Summary</h2>
            </div>

            {/* Statistics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-900/10 border-blue-200 dark:border-blue-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-blue-700 dark:text-blue-400">{summary?.total_requests ?? "—"}</div>
                  <p className="text-sm text-blue-600 dark:text-blue-300 mt-1">Total Requests</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-900/10 border-green-200 dark:border-green-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-green-700 dark:text-green-400">{summary?.settled_transactions ?? "—"}</div>
                  <p className="text-sm text-green-600 dark:text-green-300 mt-1">Settled Transactions</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-yellow-50 to-yellow-100 dark:from-yellow-900/20 dark:to-yellow-900/10 border-yellow-200 dark:border-yellow-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-yellow-700 dark:text-yellow-400">{summary?.pending_transactions ?? "—"}</div>
                  <p className="text-sm text-yellow-600 dark:text-yellow-300 mt-1">Pending Transactions</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-red-50 to-red-100 dark:from-red-900/20 dark:to-red-900/10 border-red-200 dark:border-red-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-red-700 dark:text-red-400">{summary?.failed_transactions ?? "—"}</div>
                  <p className="text-sm text-red-600 dark:text-red-300 mt-1">Failed Transactions</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-900/10 border-purple-200 dark:border-purple-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-purple-700 dark:text-purple-400">{summary ? `${summary.total_payment_volume.toFixed(2)}π` : "—"}</div>
                  <p className="text-sm text-purple-600 dark:text-purple-300 mt-1">Total Payment Volume</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/20 dark:to-indigo-900/10 border-indigo-200 dark:border-indigo-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-indigo-700 dark:text-indigo-400">{summary ? `${summary.total_settled_amount.toFixed(2)}π` : "—"}</div>
                  <p className="text-sm text-indigo-600 dark:text-indigo-300 mt-1">Total Settled Amount</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-900/10 border-orange-200 dark:border-orange-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-orange-700 dark:text-orange-400">{summary ? `${summary.total_awaiting_amount.toFixed(2)}π` : "—"}</div>
                  <p className="text-sm text-orange-600 dark:text-orange-300 mt-1">Total Awaiting Amount</p>
                </CardContent>
              </Card>
            </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Filters
            </CardTitle>
            <CardDescription>Filters affect the payment list only.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label htmlFor="search-input" className="text-sm font-medium mb-2 block">
                  Search
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    id="search-input"
                    placeholder="Search by ID or note..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="status-select" className="text-sm font-medium mb-2 block">
                  Status
                </label>
                <select
                  id="status-select"
                  value={filterStatus}
                  onChange={(e) => {
                    const value = e.target.value
                    if (isValidPaymentStatusFilter(value)) {
                      setFilterStatus(value)
                    }
                  }}
                  className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800 w-full"
                >
                  <option value="all">All Status</option>
                  <option value="settled_to_merchant">Settled to Merchant</option>
                  <option value="paid_to_app">Paid to App</option>
                  <option value="settlement_pending">Settlement Pending</option>
                  <option value="settlement_failed">Settlement Failed</option>
                  <option value="failed">Failed</option>
                  <option value="pending">Pending</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>

              <div>
                <label htmlFor="date-from" className="text-sm font-medium mb-2 block">
                  From Date
                </label>
                <input
                  id="date-from"
                  type="date"
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                  max={filterDateTo || undefined}
                  className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800 w-full"
                />
              </div>

              <div>
                <label htmlFor="date-to" className="text-sm font-medium mb-2 block">
                  To Date
                </label>
                <input
                  id="date-to"
                  type="date"
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                  min={filterDateFrom || undefined}
                  className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800 w-full"
                />
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={() => {
                  setSearchQuery("")
                  setFilterStatus("all")
                  setFilterDateFrom("")
                  setFilterDateTo("")
                  setError(null)
                  setExportError(null)
                }}
                variant="outline"
              >
                Reset Filters
              </Button>
              <Button
                onClick={exportToCSV}
                variant="outline"
                className="gap-2"
                disabled={loading || exporting || !!error}
              >
                {exporting ? (
                  <>
                    <Spinner className="h-4 w-4" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Export CSV
                  </>
                )}
              </Button>
            </div>
            {exportError && (
              <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-400 rounded text-sm">
                {exportError}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payments {filteredPayments.length > 0 && `(${filteredPayments.length})`}</CardTitle>
            <CardDescription>Click any payment to view receipt details</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : error ? (
              <div className="p-4 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-400 rounded-lg text-sm">
                {error}
              </div>
            ) : filteredPayments.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No payments found matching your filters</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredPayments.map((payment) => (
                  <div
                    key={payment.id}
                    onClick={() => router.push(`/receipts/${payment.id}`)}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50 dark:hover:bg-slate-900/50 cursor-pointer transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="font-mono text-sm text-muted-foreground truncate">
                          {payment.id.substring(0, 8)}...
                        </div>
                        <Badge className={getStatusColor(payment.status)}>
                          {payment.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 truncate">
                        {payment.note || "No note"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                        {formatDate(payment.createdAt)}
                      </p>
                    </div>

                    <div className="text-right ml-4">
                      <div className="text-lg font-bold">
                        {payment.amount.toFixed(2)}π
                      </div>
                      {payment.completedAt && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Completed: {formatDate(payment.completedAt)}
                        </p>
                      )}
                    </div>

                    <ChevronRight className="h-5 w-5 text-muted-foreground ml-4 flex-shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </main>
  )
}
