"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { BackButton } from "@/components/back-button"
import { Spinner } from "@/components/ui/spinner"
import { FlashPayReceiptCard } from "@/components/flashpay-receipt-card"
import { config } from "@/lib/config"
import { getReceiptLink } from "@/lib/router"
import type { MerchantReceiptDisplayView, PostgresHistoricalReceiptView } from "@/lib/types"
import { Printer } from "lucide-react"
import { useUnifiedStore } from "@/lib/unified-store"
import { useI18n } from "@/components/i18n-provider"

export default function ReceiptPage() {
  const params = useParams()
  const router = useRouter()
  const receiptId = params.id as string
  const [receipt, setReceipt] = useState<MerchantReceiptDisplayView | null>(null)
  const [loading, setLoading] = useState(true)
  const store = useUnifiedStore()
  const merchant = store.getMerchantState()
  const { t } = useI18n()

  useEffect(() => {
    const fetchReceipt = async () => {
      try {
        setLoading(true)
        const headers: HeadersInit = { "Content-Type": "application/json" }
        if (merchant?.accessToken) headers.Authorization = `Bearer ${merchant.accessToken}`
        const response = await fetch(`${config.appUrl}/api/receipts/${encodeURIComponent(receiptId)}`, { headers })
        if (response.ok) {
          const nextReceipt = await response.json() as MerchantReceiptDisplayView
          setReceipt(nextReceipt)
          if (!("receiptAuthority" in nextReceipt) && nextReceipt.flashPayPaymentId && nextReceipt.flashPayPaymentId !== receiptId) {
            router.replace(getReceiptLink(nextReceipt.flashPayPaymentId), { scroll: false })
          }
        } else setReceipt(null)
      } catch {
        setReceipt(null)
      } finally {
        setLoading(false)
      }
    }
    if (receiptId) void fetchReceipt()
  }, [receiptId, merchant?.accessToken, router])

  if (loading) return <main className="min-h-screen bg-background flex items-center justify-center"><Spinner /></main>

  if (!receipt) {
    return (
      <main className="min-h-screen bg-background pb-20">
        <div className="max-w-2xl mx-auto p-4">
          <BackButton />
          <div className="mt-6 rounded-lg border p-6 text-center text-muted-foreground">{t("receipt.notFound", "Receipt not found or not available yet.")}</div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background pb-20 print:bg-white">
      <div className="max-w-2xl mx-auto px-4 pb-4 pt-12 space-y-5 print:p-0">
        <div className="flex items-center justify-between print:hidden">
          <h1 className="text-2xl font-bold">{t("receipt.title", "Receipt")}</h1>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" /> {t("receipt.print", "Print")}
            </Button>
            <BackButton />
          </div>
        </div>
        {"receiptAuthority" in receipt ? (
          <PostgresReceiptCard receipt={receipt} />
        ) : (
          <FlashPayReceiptCard receipt={receipt} accessToken={merchant?.accessToken ?? null} />
        )}
      </div>
    </main>
  )
}

/** Only renders the exact, authenticated PostgreSQL transaction/receipt pairing.
 * This is a printable historical receipt, NOT a newly certified FlashPay ID.
 */
function PostgresReceiptCard({ receipt }: { receipt: PostgresHistoricalReceiptView }) {
  const { t, locale } = useI18n()
  const recorded = new Date(receipt.receiptRecordedAt)
  return (
    <section className="rounded-lg border p-6 space-y-5 print:border-0" aria-label="Historical PostgreSQL receipt">
      <div>
        <p className="font-semibold text-xl">{t("receipt.paymentReceipt", "Payment receipt")}</p>
        <p className="text-sm text-muted-foreground">Historical receipt — PostgreSQL record</p>
      </div>
      <div className="text-center text-3xl font-bold">{receipt.amount.toFixed(2)} {receipt.currency}</div>
      <div className="grid grid-cols-2 gap-4">
        <div><p className="text-xs text-muted-foreground">{t("receipt.merchant")}</p><p>{receipt.merchantName}</p></div>
        <div><p className="text-xs text-muted-foreground">{t("receipt.customer")}</p><p>{receipt.customerName ?? t("common.unavailable")}</p></div>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Receipt timestamp (not original payment creation time)</p>
        <p dir="ltr">{Number.isFinite(recorded.getTime()) ? recorded.toLocaleString(locale) : t("common.unavailable")}</p>
      </div>
      <div><p className="text-xs text-muted-foreground">Stored settlement status</p><p>{t(`receipt.status.${receipt.status}`)}</p></div>
      {receipt.note && <div><p className="text-xs text-muted-foreground">{t("receipt.note")}</p><p>{receipt.note}</p></div>}
      <div className="rounded border p-3">
        <p className="text-xs font-semibold text-muted-foreground">PostgreSQL transaction ID (not FlashPay payment ID)</p>
        <code className="break-all text-sm">{receipt.transactionId}</code>
      </div>
      <p className="text-xs text-muted-foreground">This display reflects the PostgreSQL receipt record. Independent Pi/Horizon finality and the original payment creation time are not certified by this view. Use Print → Save as PDF for a copy.</p>
    </section>
  )
}
