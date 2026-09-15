"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FlashPayReceiptView } from "@/lib/types"
import { Check, Copy, Download, Loader2, Share2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useI18n } from "@/components/i18n-provider"

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
  shareFile?: (payload: unknown) => Promise<unknown> | unknown
  openShareDialog?: (title: string, message: string) => Promise<unknown> | unknown
  openUrlInSystemBrowser?: (url: string) => Promise<unknown> | unknown
}

function shareErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Pi Browser/WebViews may expose Clipboard API while rejecting writes.
    }
  }

  if (typeof document === "undefined") return false
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, value.length)
  let copied = false
  try {
    copied = document.execCommand("copy")
  } catch {
    copied = false
  } finally {
    textarea.remove()
  }
  return copied
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
  const { t, locale, direction } = useI18n()
  const [copied, setCopied] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfTools, setPdfTools] = useState<ReceiptPdfTools | null>(null)
  const [pdfFailed, setPdfFailed] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
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
    setShareError(null)
    sharedPdfUrlRef.current = null
    sharedPdfPromiseRef.current = null
    void import("@/lib/receipt-pdf")
      .then(async (tools) => {
        const file = await tools.createReceiptPdfFile(receiptSnapshot, {
          direction,
          labels: {
            paymentReceipt: t("receipt.paymentReceipt"),
            refundReceipt: t("receipt.refundReceipt"),
            merchant: t("receipt.merchant"),
            customer: t("receipt.customer"),
            unavailable: t("common.unavailable"),
            type: t("receipt.type"),
            payment: t("receipt.payment"),
            refund: t("receipt.refund"),
            dateTime: t("receipt.dateTime"),
            note: t("receipt.note"),
            flashPayId: t("receipt.flashpayId"),
            verified: t("receipt.verified"),
            status: {
              successful: t("receipt.status.successful"),
              processing: t("receipt.status.processing"),
              refunded: t("receipt.status.refunded"),
              failed: t("receipt.status.failed"),
              cancelled: t("receipt.status.cancelled"),
              needs_attention: t("receipt.status.needs_attention"),
            },
          },
        })
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
    locale,
    direction,
    t,
  ])

  const copyId = async () => {
    if (!(await copyText(receipt.flashPayPaymentId))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
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
    setShareError(null)
    try {
      const pi = getPiNativeBridge()
      const failures: string[] = []

      // Actual attachment path #1: invoke Web Share Level 2 directly. Do not trust
      // canShare() as the sole gate because Android WebViews can misreport file support.
      // Keep the payload strictly file-only to avoid WebView implementations that
      // reject mixed file + title/text/url share payloads.
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ files: [pdfFile] })
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`web-pdf: ${shareErrorMessage(error)}`)
        }
      }

      // Actual attachment path #2: Pi Browser builds that expose a native file bridge.
      // Use the smallest payload first; extra text/title fields are intentionally omitted
      // because the Android bridge only needs the file and filename for ACTION_SEND.
      if (typeof pi?.shareFile === "function") {
        try {
          await pi.shareFile({ filename: pdfFile.name, file: pdfFile })
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`pi-pdf-object: ${shareErrorMessage(error)}`)
        }

        // Pi.shareFile is a newly rolled-out native capability and Pi Browser builds
        // in the field do not all expose the same JS bridge shape yet. If the object
        // payload is rejected, retry the exact same pre-generated File as the single
        // argument. No URL/text fallback is involved, so success always means a real
        // attachment was handed to the native share sheet.
        try {
          await pi.shareFile(pdfFile)
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`pi-pdf-file: ${shareErrorMessage(error)}`)
        }
      }

      // Some Android bridges reject application/pdf while accepting generic binary. The
      // bytes and .pdf filename remain unchanged, so receiving apps still get the PDF file.
      const genericPdfFile = new File([pdfFile], pdfFile.name, {
        type: "application/octet-stream",
        lastModified: pdfFile.lastModified,
      })

      if (typeof pi?.shareFile === "function") {
        try {
          await pi.shareFile({ filename: genericPdfFile.name, file: genericPdfFile })
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`pi-binary-object: ${shareErrorMessage(error)}`)
        }
        try {
          await pi.shareFile(genericPdfFile)
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`pi-binary-file: ${shareErrorMessage(error)}`)
        }
      }

      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ files: [genericPdfFile] })
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`web-binary: ${shareErrorMessage(error)}`)
        }
      }

      // This Pi Browser build cannot hand a PDF File to Android's native share sheet.
      // Restore the previously proven share-sheet behavior as an explicit, last-resort
      // secure-link fallback instead of leaving Share PDF dead. iPhone/other browsers
      // still return above through the real File attachment path.
      let url: string | null = null
      try {
        url = await ensureSharedPdfUrl()
      } catch (error) {
        failures.push(`pdf-url: ${shareErrorMessage(error)}`)
      }

      if (url && typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: receipt.transactionType === "refund" ? "FlashPay Refund Receipt" : "FlashPay Payment Receipt",
            text: `FlashPay receipt ${receipt.flashPayPaymentId}`,
            url,
          })
          setShareError("This Pi Browser shared a secure PDF link because it does not support PDF file attachments.")
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`web-url: ${shareErrorMessage(error)}`)
        }
      }

      if (url && typeof pi?.openShareDialog === "function") {
        try {
          pi.openShareDialog(
            receipt.transactionType === "refund" ? "FlashPay Refund Receipt" : "FlashPay Payment Receipt",
            `FlashPay receipt ${receipt.flashPayPaymentId}\n${url}`,
          )
          setShareError("This Pi Browser shared a secure PDF link because it does not support PDF file attachments.")
          return
        } catch (error) {
          if (isAbortError(error)) return
          failures.push(`pi-url: ${shareErrorMessage(error)}`)
        }
      }

      console.warn("[Receipt PDF] Share unavailable", {
        paymentId: receipt.flashPayPaymentId,
        failures: failures.slice(0, 8),
      })
      setShareError("PDF sharing is unavailable in this Pi Browser build. Download PDF is still available.")
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
            <CardTitle className="mt-1 text-2xl">{receipt.transactionType === "refund" ? t("receipt.refundReceipt") : t("receipt.paymentReceipt")}</CardTitle>
          </div>
          <Badge variant={receipt.status === "failed" || receipt.status === "needs_attention" ? "destructive" : "default"}>
            {t(`receipt.status.${receipt.status}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <div className="text-center border-b pb-5">
          <div className="text-4xl font-bold">{receipt.amount.toFixed(2)} {receipt.currency}</div>
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted p-4">
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.merchant")}</p><p className="mt-1 font-semibold">{receipt.merchantName}</p></div>
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.customer")}</p><p className="mt-1 font-semibold">{receipt.customerName ?? t("common.unavailable")}</p></div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.type")}</p><p className="mt-1 font-medium">{receipt.transactionType === "refund" ? t("receipt.refund") : t("receipt.payment")}</p></div>
          <div><p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.dateTime")}</p><p className="mt-1 font-medium" dir="ltr" lang="en">{formatDateTime(receipt.occurredAt)}</p></div>
        </div>

        {receipt.note && <div><p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.note")}</p><p className="mt-1">{receipt.note}</p></div>}

        <div className="rounded-lg border p-4">
          <p className="text-xs font-semibold uppercase text-muted-foreground">{t("receipt.flashpayId")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-sm font-semibold">{receipt.flashPayPaymentId}</code>
            <Button type="button" variant="ghost" size="sm" className="print:hidden" onClick={copyId} aria-label={t("receipt.copyId")}>
              {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="print:hidden grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
          <Button type="button" variant="outline" onClick={sharePdf} disabled={!pdfFile || !pdfTools || sharing || pdfFailed}>
            {sharing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Share2 className="mr-2 h-4 w-4" />}
            {pdfFailed ? t("receipt.pdfUnavailable") : pdfFile ? t("receipt.sharePdf") : t("receipt.preparingPdf")}
          </Button>
          <Button type="button" variant="outline" onClick={downloadPdf} disabled={!pdfFile || !pdfTools || pdfFailed}>
            <Download className="mr-2 h-4 w-4" />{t("receipt.downloadPdf")}
          </Button>
        </div>

        {shareError && <p className="print:hidden text-center text-xs text-amber-700">{shareError}</p>}

        <div className="border-t pt-4 text-center text-xs text-muted-foreground">{t("receipt.verified")}</div>
      </CardContent>
    </Card>
  )
}
