"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { BackButton } from "@/components/back-button"
import { Spinner } from "@/components/ui/spinner"
import { useMerchant } from "@/lib/use-merchant"
import { config } from "@/lib/config"
import type { Transaction } from "@/lib/types"
import { Calendar, Search, Download, ChevronRight } from "lucide-react"

type TransactionSummary = {
  total_payment_volume: number
  total_awaiting_amount: number
  total_completed_amount: number
  total_settled_amount: number
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
})

function formatTransactionDate(createdAt: string): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) {
    return "Unavailable"
  }
  return dateFormatter.format(date)
}

export default function TransactionsPage() {
  const router = useRouter()
  const merchant = useMerchant()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [summary, setSummary] = useState<TransactionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterAmount, setFilterAmount] = useState("")

  const fetchTransactions = async () => {
    if (!merchant?.merchantId) return

    try {
      setLoading(true)
      
      // Get accessToken from merchant context or session storage
      const accessToken = merchant.accessToken || sessionStorage.getItem("accessToken")
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      }
      
      if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`
      }
      
      const response = await fetch(`${config.appUrl}/api/transactions?merchantId=${merchant.merchantId}&limit=100`, {
        headers,
      })
      if (response.ok) {
        const data = await response.json()
        setTransactions(data.transactions || [])
        setSummary(data.summary)
      }
    } catch (error) {
      console.error("Error fetching transactions:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (merchant?.merchantId) {
      fetchTransactions()
    }
  }, [merchant?.merchantId])

  const filteredTransactions = transactions.filter((txn) => {
    const matchesSearch =
      !searchQuery || txn.reference.toLowerCase().includes(searchQuery.toLowerCase()) ||
      txn.description.toLowerCase().includes(searchQuery.toLowerCase())
    
    // Parse amount filter once - disable if empty or non-finite
    let matchesAmount = true
    if (filterAmount) {
      const targetAmount = parseFloat(filterAmount)
      if (isFinite(targetAmount)) {
        matchesAmount = txn.amount >= targetAmount * 0.95 && txn.amount <= targetAmount * 1.05
      } else {
        matchesAmount = false
      }
    }
    
    return matchesSearch && matchesAmount
  })

  const handleViewReceipt = (transactionId: string) => {
    router.push(`/receipts/${transactionId}`)
  }

  const handleExport = async () => {
    if (filteredTransactions.length === 0) {
      return
    }

    // Helper function to escape CSV cell values
    const escapeCsvCell = (cell: unknown): string => {
      const value = cell === null || cell === undefined ? "" : String(cell)
      const escaped = value.replace(/"/g, '""')
      return `"${escaped}"`
    }

    // Build CSV content
    const headers = ["Reference", "Amount (π)", "Date", "Status", "Description"]
    const rows = filteredTransactions.map((txn) => [
      escapeCsvCell(txn.reference),
      escapeCsvCell(txn.amount.toString()),
      escapeCsvCell(formatTransactionDate(txn.createdAt)),
      escapeCsvCell(txn.settlementStatus && txn.settlementStatus.length > 0 ? txn.settlementStatus : txn.status),
      escapeCsvCell(txn.description),
    ])

    const csvContent =
      "\uFEFF" +
      [headers.map(escapeCsvCell).join(","), ...rows.map((row) => row.join(","))].join("\r\n")

    // Create File with correct date format
    const today = new Date().toISOString().split("T")[0]
    const file = new File([csvContent], `transactions-${today}.csv`, {
      type: "text/csv;charset=utf-8",
    })

    // Try navigator.share if supported
    if (navigator.share) {
      try {
        await navigator.share({
          files: [file],
          title: "Transactions Export",
          text: "Export of transaction history",
        })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return
        }
        console.error("Share failed:", error)
      }
    }

    // Fallback: download via hidden link
    const url = URL.createObjectURL(file)
    const link = document.createElement("a")
    link.href = url
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // Revoke URL after delay
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1000)
  }

  return (
    <main className="min-h-screen bg-background pb-20">
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Transaction History</h1>
            <p className="text-sm text-muted-foreground mt-1">Complete record of all payments</p>
          </div>
          <BackButton />
        </div>

        {/* Payment Summary */}
        {summary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Payment Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Payment Volume:</span>
                <span className="font-semibold text-lg">{summary.total_payment_volume.toFixed(2)}π</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Awaiting Amount:</span>
                <span className="font-semibold">{summary.total_awaiting_amount.toFixed(2)}π</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Completed Amount:</span>
                <span className="font-semibold">{summary.total_completed_amount.toFixed(2)}π</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Settled Amount:</span>
                <span className="font-semibold">{summary.total_settled_amount.toFixed(2)}π</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search and Filter */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by reference or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Filter by amount (π)"
              type="number"
              value={filterAmount}
              onChange={(e) => setFilterAmount(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleExport} variant="outline" size="sm">
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Transactions List */}
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : filteredTransactions.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-center text-muted-foreground">
                {transactions.length === 0 ? "No transactions yet" : "No transactions match your filters"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filteredTransactions.map((txn) => (
              <Card
                key={txn.transactionId}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => handleViewReceipt(txn.transactionId)}
              >
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Badge variant="secondary">{txn.reference}</Badge>
                        <span className="text-sm text-muted-foreground flex items-center gap-1" dir="ltr" lang="en">
                          <Calendar className="h-3 w-3" />
                          {formatTransactionDate(txn.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">{txn.description}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-foreground">{txn.amount} π</div>
                      <Badge
                        variant={
                          txn.settlementStatus === "settled_to_merchant" || txn.status === "completed"
                            ? "default"
                            : "secondary"
                        }
                        className="text-xs"
                      >
                        {txn.settlementStatus && txn.settlementStatus.length > 0 ? txn.settlementStatus : txn.status}
                      </Badge>
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground ml-2" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
