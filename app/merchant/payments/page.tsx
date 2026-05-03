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
import { MerchantSettlementsView } from "@/components/merchant-settlements-view"
import type { Payment } from "@/lib/types"
import { Calendar, Search, Download, ChevronRight, TrendingUp, Filter } from "lucide-react"

interface MerchantPayment extends Payment {
  paidAt?: string
  createdAt: string
}

export default function MerchantPaymentsPage() {
  const router = useRouter()
  const merchant = useMerchant()
  const [activeTab, setActiveTab] = useState<"payments" | "settlements">("payments")
  const [payments, setPayments] = useState<MerchantPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterStatus, setFilterStatus] = useState<"all" | "paid" | "pending" | "failed" | "cancelled">("all")
  const [filterDateFrom, setFilterDateFrom] = useState("")
  const [filterDateTo, setFilterDateTo] = useState("")

  const fetchPayments = async () => {
    if (!merchant?.id) return

    try {
      setLoading(true)
      const params = new URLSearchParams({
        merchantId: merchant.id,
        limit: "100",
      })

      if (filterDateFrom) params.append("fromDate", filterDateFrom)
      if (filterDateTo) params.append("toDate", filterDateTo)

      const response = await fetch(`${config.appUrl}/api/merchant/payments?${params.toString()}`)
      if (response.ok) {
        const data = await response.json()
        setPayments(Array.isArray(data.payments) ? data.payments : [])
      }
    } catch (error) {
      console.error("[Merchant Payments] Error fetching payments:", error)
      setPayments([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPayments()
  }, [merchant?.id, filterDateFrom, filterDateTo])

  const filteredPayments = payments.filter((p) => {
    const matchesSearch =
      p.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.note.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = filterStatus === "all" || p.status.toLowerCase() === filterStatus
    return matchesSearch && matchesStatus
  })

  const stats = {
    total: payments.length,
    paid: payments.filter((p) => p.status === "PAID").length,
    pending: payments.filter((p) => p.status === "PENDING").length,
    totalVolume: payments.filter((p) => p.status === "PAID").reduce((sum, p) => sum + p.amount, 0),
  }

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "paid":
        return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
      case "pending":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
      case "failed":
        return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
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

  const exportToCSV = () => {
    const headers = ["Payment ID", "Amount (π)", "Status", "Note", "Created", "Paid"]
    const rows = filteredPayments.map((p) => [
      p.id,
      p.amount.toString(),
      p.status,
      p.note,
      formatDate(p.createdAt),
      p.paidAt ? formatDate(p.paidAt) : "-",
    ])

    const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n")

    const blob = new Blob([csv], { type: "text/csv" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `payments-export-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
  }

  if (!merchant?.id) {
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

        {/* Tabs */}
        <div className="flex gap-2 border-b">
          <button
            onClick={() => setActiveTab("payments")}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === "payments"
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Payment Requests
          </button>
          <button
            onClick={() => setActiveTab("settlements")}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeTab === "settlements"
                ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Settlements & Payouts
          </button>
        </div>

        {/* Payments Tab */}
        {activeTab === "payments" && (
          <div className="space-y-6">
            {/* Statistics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-900/10 border-blue-200 dark:border-blue-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-blue-700 dark:text-blue-400">{stats.total}</div>
                  <p className="text-sm text-blue-600 dark:text-blue-300 mt-1">Total Requests</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-900/10 border-green-200 dark:border-green-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-green-700 dark:text-green-400">{stats.paid}</div>
                  <p className="text-sm text-green-600 dark:text-green-300 mt-1">Paid</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-yellow-50 to-yellow-100 dark:from-yellow-900/20 dark:to-yellow-900/10 border-yellow-200 dark:border-yellow-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-yellow-700 dark:text-yellow-400">{stats.pending}</div>
                  <p className="text-sm text-yellow-600 dark:text-yellow-300 mt-1">Pending</p>
                </CardContent>
              </Card>

              <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-900/10 border-purple-200 dark:border-purple-800">
                <CardContent className="pt-6">
                  <div className="text-3xl font-bold text-purple-700 dark:text-purple-400">{stats.totalVolume.toFixed(2)}π</div>
                  <p className="text-sm text-purple-600 dark:text-purple-300 mt-1">Total Volume</p>
                </CardContent>
              </Card>
            </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Search by ID or note..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800"
              >
                <option value="all">All Status</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>

              <input
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800"
              />

              <input
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                className="px-4 py-2 border rounded-lg bg-background dark:bg-slate-950 border-input dark:border-slate-800"
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setSearchQuery("")
                  setFilterStatus("all")
                  setFilterDateFrom("")
                  setFilterDateTo("")
                }}
                variant="outline"
              >
                Reset Filters
              </Button>
              <Button onClick={exportToCSV} variant="outline" className="gap-2">
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </div>
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
                      {payment.paidAt && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Paid: {formatDate(payment.paidAt)}
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
        )}

        {/* Settlements Tab */}
        {activeTab === "settlements" && (
          <MerchantSettlementsView merchantId={merchant?.id || null} />
        )}
      </div>
    </main>
  )
}
