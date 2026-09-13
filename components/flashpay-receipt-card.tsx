"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FlashPayReceiptView } from "@/lib/types"
import { Check, Copy, Download, Loader2, Share2 } from "lucide-react"
import { useEffect, useState } from "react"

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", numberingSystem: "latn",
})

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Unavailable"
  const parts = Object.fromEntries(dateTimeFormatter.formatToParts(date).map(({ type, value }) => [type, value]))
  return `${parts.day} ${parts.month} ${parts.year} · ${parts.hour}:${parts.minute}:${parts.second}`
}

const STATUS_LABEL: Record<FlashPayReceiptView["status"], string> = {
  successful: "Payment successful", processing: "Processing", refunded: "Refunded", failed: "Payment failed",
  cancelled: "Cancelled", needs_attention: "Needs attention",
}

export function FlashPayReceiptCard({ receipt }: { receipt: FlashPayReceiptView }) {
  const [copied, setCopied] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [sharing, setSharing] = useState(false)
  useEffect(() => {
    let cancelled = false
    const receiptSnapshot: FlashPayReceiptView = {
      flashPayPaymentId: receipt.flashPayPaymentId,
      merchantName: receipt.merchantName,
      customerName: receipt.customerName,
      amount: receipt.amount,
      currency: receipt.currency,
      transactionType: receipt.transactionType,
      status: receipt.status,
      occurredAt: receipt.occurredAt,
      note: receipt.note,
    }
    setPdfFile(null)
    setPdfFailed(false)
    void import("@/lib/receipt-pdf")
      .then(({ createReceiptPdfFile }) => createReceiptPdfFile(receiptSnapshot))
      .then((file) => { if (!cancelled) setPdfFile(file) })
      .catch(() => { if (!cancelled) setPdfFailed(true) })
    return () => { cancelled = true }
  }, [
    receipt.flashPayPaymentId,
    receipt.merchantName,
    receipt.customerName,
    receipt.amount,
    receipt.currency,
    receipt.transactionType,
    receipt.status,
    receipt.occurredAt,
    receipt.note,
  ])

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(receipt.flashPayPaymentId)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {}
  }

  const downloadPdf = async () => {
    if (!pdfFile) return
    const { downloadReceiptPdfFile } = await import("@/lib/receipt-pdf")
    downloadReceiptPdfFile(pdfFile)
  }

  const sharePdf = async () => {
    if (!pdfFile || sharing) return
    setSharing(true)
    try {
      const sharePayload = {
        files: [pdfFile],
        title: receipt.transactionType === "refund" ? "FlashPay Refund Receipt" : "FlashPay Payment Receipt",
        text: `FlashPay receipt ${receipt.flashPayPaymentId}`,
      }
      if (typeof navigator.share === "function" && typeof navigator.canShare === "function") {
        let canShareFile = false
        try {
          canShareFile = navigator.canShare({ files: [pdfFile] })
        } catch {
          canShareFile = false
        }
        if (canShareFile) {
          try {
            await navigator.share(sharePayload)
            return
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return
          }
        }
      }
      const { downloadReceiptPdfFile } = await import("@/lib/receipt-pdf")
      downloadReceiptPdfFile(pdfFile)
    } finally {
      setSharing(false)
    }
  }

  return (
    <Card className="print:shadow-none">
      <CardHeader className="border-b">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">FlashPay</p>
            <CardTitle className="mt-1 text-2xl">{receipt.transactionType === "refund" ? "Refund Receipt" : "Payment Receipt"}</CardTitle>
          </div>
          <Badge variant={receipt.status === "failed" || receipt.status === "needs_attention" ? "destructive" : "default"}>
            {STATUS_LABEL[receipt.status]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <div className="text-center border-b pb-5">
          <div className="text-4xl font-bold">{receipt.amount.toFixed(2)} {receipt.currency}</div>
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted p-4">
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Merchant</p><p className="mt-1 font-semibold">{receipt.merchantName}</p></div>
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Customer</p><p className="mt-1 font-semibold">{receipt.customerName ?? "Name unavailable"}</p></div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Type</p><p className="mt-1 font-medium">{receipt.transactionType === "refund" ? "Refund" : "Payment"}</p></div>
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Date & Time</p><p className="mt-1 font-medium" dir="ltr" lang="en">{formatDateTime(receipt.occurredAt)}</p></div>
        </div>

        {receipt.note && <div><p className="text-xs font-semibold uppercase text-muted-foreground">Note</p><p className="mt-1">{receipt.note}</p></div>}

        <div className="rounded-lg border p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">FlashPay ID</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-sm font-semibold">{receipt.flashPayPaymentId}</code>
            <Button type="button" variant="ghost" size="sm" className="print:hidden" onClick={copyId} aria-label="Copy FlashPay ID">
              {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="print:hidden grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
          <Button type="button" variant="outline" onClick={sharePdf} disabled={!pdfFile || sharing || pdfFailed}>
            {sharing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Share2 className="mr-2 h-4 w-4" />}
            {pdfFailed ? "PDF unavailable" : pdfFile ? "Share PDF" : "Preparing PDF…"}
          </Button>
          <Button type="button" variant="outline" onClick={downloadPdf} disabled={!pdfFile || pdfFailed}>
            <Download className="mr-2 h-4 w-4" /> Download PDF
          </Button>
        </div>

        <div className="border-t pt-4 text-center text-xs text-muted-foreground">Verified transaction record by FlashPay</div>
      </CardContent>
    </Card>
  )
}
