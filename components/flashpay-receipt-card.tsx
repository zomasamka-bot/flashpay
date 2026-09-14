"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FlashPayReceiptView } from "@/lib/types"
import { Check, Copy, Download, Loader2, Share2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

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

type PiNativeBridge = {
  shareFile?: (payload: { filename: string; file: File; title?: string; text?: string }) => Promise<unknown> | unknown
  openShareDialog?: (title: string, message: string) => Promise<unknown> | unknown
  openUrlInSystemBrowser?: (url: string) => Promise<unknown> | unknown
}

function shareErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

type ReceiptPdfTools = typeof import("@/lib/receipt-pdf")

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function getPiNativeBridge(): PiNativeBridge | null {
  if (typeof window === "undefined") return null
  const pi = window.Pi as (typeof window.Pi & PiNativeBridge) | undefined
  return pi ?? null
}

function webFileShareSupport(file: File): "supported" | "unknown" | "unsupported" {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return "unsupported"
  if (typeof navigator.canShare !== "function") return "unknown"
  try {
    return navigator.canShare({ files: [file] }) ? "supported" : "unsupported"
  } catch {
    return "unknown"
  }
}

export function FlashPayReceiptCard({ receipt, accessToken }: { receipt: FlashPayReceiptView; accessToken?: string | null }) {
  const [copied, setCopied] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfTools, setPdfTools] = useState<ReceiptPdfTools | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [sharing, setSharing] = useState(false)
  const sharedPdfUrlRef = useRef<string | null>(null)
  const sharedPdfPromiseRef = useRef<Promise<string> | null>(null)
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
    setPdfTools(null)
    setPdfFailed(false)
    sharedPdfUrlRef.current = null
    sharedPdfPromiseRef.current = null
    void import("@/lib/receipt-pdf")
      .then(async (tools) => {
        const file = await tools.createReceiptPdfFile(receiptSnapshot)
        if (!cancelled) {
          setPdfTools(tools)
          setPdfFile(file)
        }
      })
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

  const ensureSharedPdfUrl = async (): Promise<string> => {
    if (sharedPdfUrlRef.current) return sharedPdfUrlRef.current
    if (sharedPdfPromiseRef.current) return sharedPdfPromiseRef.current
    if (!pdfFile || !accessToken) throw new Error("Authenticated PDF link unavailable")

    const promise = fetch("/api/receipt-files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf",
        "X-FlashPay-Payment-Id": receipt.flashPayPaymentId,
      },
      body: pdfFile,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Receipt PDF link failed: ${response.status}`)
      const payload = await response.json() as { url?: unknown }
      if (typeof payload.url !== "string" || !payload.url.startsWith("https://")) {
        throw new Error("Receipt PDF link missing")
      }
      sharedPdfUrlRef.current = payload.url
      return payload.url
    }).finally(() => {
      sharedPdfPromiseRef.current = null
    })

    sharedPdfPromiseRef.current = promise
    return promise
  }

  const downloadPdf = async () => {
    if (!pdfFile || !pdfTools) return
    let url: string
    try {
      url = await ensureSharedPdfUrl()
    } catch {
      // iOS can still save the actual PDF through its native file share sheet
      // when an authenticated HTTPS link cannot be created.
      if (webFileShareSupport(pdfFile) === "supported" && typeof navigator.share === "function") {
        try {
          await navigator.share({ files: [pdfFile], title: "Save FlashPay Receipt" })
          return
        } catch (error) {
          if (isAbortError(error)) return
        }
      }
      pdfTools.downloadReceiptPdfFile(pdfFile)
      return
    }

    const downloadUrl = `${url}?download=1`
    const pi = getPiNativeBridge()
    if (typeof pi?.openUrlInSystemBrowser === "function") {
      try {
        await pi.openUrlInSystemBrowser(downloadUrl)
        return
      } catch {
        // Continue to a normal HTTPS navigation if this Pi Browser build does
        // not expose the native system-browser bridge.
      }
    }
    pdfTools.openHttpsPdfUrl(downloadUrl)
  }

  const sharePdf = async () => {
    if (!pdfFile || !pdfTools || sharing) return
    setSharing(true)
    try {
      const title = receipt.transactionType === "refund" ? "FlashPay Refund Receipt" : "FlashPay Payment Receipt"
      const text = `FlashPay receipt ${receipt.flashPayPaymentId}`
      const webSupport = webFileShareSupport(pdfFile)
      const pi = getPiNativeBridge()


      // Preserve the proven iPhone/native browser path: share the actual PDF
      // file when the browser explicitly supports file sharing.
      if (webSupport !== "unsupported" && typeof navigator.share === "function") {
        try {
          await navigator.share({ files: [pdfFile], title, text })
          return
        } catch (error) {
          if (isAbortError(error)) return
        }
      }

      // Newer Pi Browser builds may expose direct file sharing. Samsung/Pi
      // Browser 1.17.1 advertises file_share but rejects application/pdf, so
      // retry the same PDF bytes/name as generic binary only for that exact
      // MIME rejection. This does not change the PDF payload or extension.
      if (typeof pi?.shareFile === "function") {
        try {
          await pi.shareFile({ filename: pdfFile.name, file: pdfFile, title, text })
          return
        } catch (error) {
          if (isAbortError(error)) return
          const firstPiShareError = shareErrorMessage(error)

          if (firstPiShareError.toLowerCase().includes("unsupported mime type")) {
            const genericPdfFile = new File([pdfFile], pdfFile.name, {
              type: "application/octet-stream",
              lastModified: pdfFile.lastModified,
            })
            try {
              await pi.shareFile({ filename: genericPdfFile.name, file: genericPdfFile, title, text })
              return
            } catch (retryError) {
              if (isAbortError(retryError)) return
              // Continue to the proven HTTPS share fallback below.
            }
          }
        }
      }

      // Keep Samsung's previously working share sheet as the final fallback.
      // The native attachment paths above are always attempted first; this URL
      // path exists only so a Pi Browser MIME limitation never makes Share dead.
      let url: string
      try {
        url = await ensureSharedPdfUrl()
      } catch {
        return
      }

      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title, text, url })
          return
        } catch (error) {
          if (isAbortError(error)) return
        }
      }

      if (typeof pi?.openShareDialog === "function") {
        try {
          await pi.openShareDialog(title, `${text}\n${url}`)
          return
        } catch (error) {
          if (isAbortError(error)) return
        }
      }

      if (typeof navigator.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(url)
        return
      }

      pdfTools.openHttpsPdfUrl(url)
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
          <Button type="button" variant="outline" onClick={sharePdf} disabled={!pdfFile || !pdfTools || sharing || pdfFailed}>
            {sharing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Share2 className="mr-2 h-4 w-4" />}
            {pdfFailed ? "PDF unavailable" : pdfFile ? "Share PDF" : "Preparing PDF…"}
          </Button>
          <Button type="button" variant="outline" onClick={downloadPdf} disabled={!pdfFile || !pdfTools || pdfFailed}>
            <Download className="mr-2 h-4 w-4" /> Download PDF
          </Button>
        </div>

        <div className="border-t pt-4 text-center text-xs text-muted-foreground">Verified transaction record by FlashPay</div>
      </CardContent>
    </Card>
  )
}
