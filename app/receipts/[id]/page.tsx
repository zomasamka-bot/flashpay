"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BackButton } from "@/components/back-button"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import { config } from "@/lib/config"
import type { Receipt } from "@/lib/types"
import { Download, Copy, Check } from "lucide-react"
import { useState as useStateForCopy } from "react"

export default function ReceiptPage() {
  const params = useParams()
  const receiptId = params.id as string
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const fetchReceipt = async () => {
      try {
        setLoading(true)
        const response = await fetch(`${config.appUrl}/api/receipts/${receiptId}`)
        if (response.ok) {
          const data = await response.json()
          setReceipt(data)
        }
      } catch (error) {
        console.error("Error fetching receipt:", error)
      } finally {
        setLoading(false)
      }
    }

    if (receiptId) {
      fetchReceipt()
    }
  }, [receiptId])

  const handleCopyReference = () => {
    if (receipt?.reference) {
      navigator.clipboard.writeText(receipt.reference)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleCopyTxid = () => {
    if (receipt?.txid) {
      navigator.clipboard.writeText(receipt.txid)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handlePrint = () => {
    window.print()
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-background flex justify-center items-center">
        <Spinner />
      </main>
    )
  }

  if (!receipt) {
    return (
      <main className="min-h-screen bg-background pb-20">
        <div className="max-w-2xl mx-auto p-4">
          <BackButton />
          <Card className="mt-6">
            <CardContent className="pt-6">
              <p className="text-center text-muted-foreground">Receipt not found</p>
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background pb-20 print:bg-white">
      <div className="max-w-2xl mx-auto p-4 space-y-6 print:p-0">
        <div className="flex items-center justify-between print:hidden">
          <h1 className="text-3xl font-bold text-foreground">Receipt</h1>
          <div className="flex gap-2">
            <Button onClick={handlePrint} variant="outline" size="sm">
              <Download className="h-4 w-4 mr-2" />
              Print
            </Button>
            <BackButton />
          </div>
        </div>

        {/* Receipt Card */}
        <Card className="print:shadow-none">
          <CardHeader className="border-b print:border-b">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-2xl">FlashPay Receipt</CardTitle>
                <p className="text-sm text-muted-foreground mt-2">{receipt.merchant.name}</p>
              </div>
              <Badge variant="default">{receipt.reference}</Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 pt-6">
            {/* Transaction Details */}
            <div className="grid grid-cols-2 gap-6 print:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Date & Time</p>
                <p className="font-semibold">
                  {new Date(receipt.timestamp).toLocaleDateString()} {new Date(receipt.timestamp).toLocaleTimeString()}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Status</p>
                <Badge variant="default" className="mt-1">
                  {receipt.status || "COMPLETED"}
                </Badge>
              </div>
            </div>

            {/* Transaction ID */}
            <div className="p-4 bg-muted rounded-lg print:bg-gray-100">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Transaction ID</p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm break-all flex-1">{receipt.transactionId}</p>
                <Button
                  onClick={() => {
                    navigator.clipboard.writeText(receipt.transactionId)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  variant="ghost"
                  size="sm"
                  className="print:hidden"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Amount */}
            <div className="py-4 border-y border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Amount</p>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-foreground">{receipt.amount}</span>
                <span className="text-2xl text-muted-foreground">{receipt.currency}</span>
              </div>
            </div>

            {/* Description */}
            {receipt.description && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Description</p>
                <p className="text-foreground">{receipt.description}</p>
              </div>
            )}

            {/* Merchant Info */}
            <div className="grid grid-cols-2 gap-6 p-4 bg-muted rounded-lg print:bg-gray-100">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Merchant</p>
                <p className="font-semibold">{receipt.merchant.name}</p>
                <p className="text-xs text-muted-foreground font-mono mt-1">{receipt.merchant.id}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Payer</p>
                <p className="font-semibold">{receipt.payer.username || "Customer"}</p>
                {receipt.payer.address && (
                  <p className="text-xs text-muted-foreground font-mono mt-1">{receipt.payer.address}</p>
                )}
              </div>
            </div>

            {/* Blockchain Details */}
            {receipt.txid && (
              <div className="p-4 bg-muted rounded-lg print:bg-gray-100">
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Blockchain Transaction (TXID)</p>
                <div className="flex items-center gap-2">
                  <p className="text-xs font-mono break-all flex-1 text-muted-foreground">{receipt.txid}</p>
                  <Button
                    onClick={handleCopyTxid}
                    variant="ghost"
                    size="sm"
                    className="print:hidden"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Reference */}
            <div className="flex items-center gap-2 p-3 bg-muted rounded-lg print:bg-gray-100">
              <span className="text-xs font-semibold text-muted-foreground uppercase">Reference:</span>
              <span className="font-mono font-bold flex-1">{receipt.reference}</span>
              <Button
                onClick={handleCopyReference}
                variant="ghost"
                size="sm"
                className="print:hidden"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>

            {/* Footer */}
            <div className="text-center pt-4 border-t border-border text-xs text-muted-foreground">
              <p>This receipt is a record of your transaction on FlashPay</p>
              <p className="mt-2">flashpay.pi</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
