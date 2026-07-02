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
import type { Transaction, MerchantBalance } from "@/lib/types"
import { Calendar, Search, Download, ChevronRight } from "lucide-react"

export default function TransactionsPage() {
  const router = useRouter()
  const merchant = useMerchant()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [balance, setBalance] = useState<MerchantBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [filterAmount, setFilterAmount] = useState("")

  const fetchTransactions = async () => {
    if (!merchant?.id) return

    try {
      setLoading(true)
      const response = await fetch(`${config.appUrl}/api/transactions?merchantId=${merchant.id}&limit=100`)
      if (response.ok) {
        const data = await response.json()
        setTransactions(data.transactions || [])
        setBalance(data.balance)
      }
    } catch (error) {
      console.error("Error fetching transactions:", error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (merchant?.id) {
      fetchTransactions()
    }
  }, [merchant?.id])

  const filteredTransactions = transactions.filter((txn) => {
    const matchesSearch =
      !searchQuery || txn.reference.toLowerCase().includes(searchQuery.toLowerCase()) ||
      txn.description.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesAmount =
      !filterAmount ||
      txn.amount >= parseFloat(filterAmount) * 0.95 ||
      txn.amount <= parseFloat(filterAmount) * 1.05
    return matchesSearch && matchesAmount
  })

  const handleViewReceipt = (transactionId: string) => {
    router.push(`/receipts/${transactionId}`)
  }

  const handleExport = () => {
    const csv = [
      ["Reference", "Amount (π)", "Date", "Status", "Description"],
      ...filteredTransactions.map((txn) => [
        txn.reference,
        txn.amount.toString(),
        new Date(txn.createdAt).toLocaleDateString(),
        txn.status,
        txn.description,
      ]),
    ]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n")

    const blob = new Blob([csv], { type: "text/csv" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `transactions-${new Date().toISOString().split("T")[0]}.csv`
    a.click()
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

        {/* Balance Summary */}
        {balance && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Balance Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Received:</span>
                <span className="font-semibold text-lg">{balance.total.toFixed(2)} π</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Unsettled:</span>
                <span className="font-semibold">{balance.unsettled.toFixed(2)} π</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Settled:</span>
                <span className="font-semibold">{balance.settled.toFixed(2)} π</span>
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
                        <span className="text-sm text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(txn.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">{txn.description}</p>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-foreground">{txn.amount} π</div>
                      <Badge
                        variant={txn.status === "completed" ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {txn.status}
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
