"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { BackButton } from "@/components/back-button"
import { Spinner } from "@/components/ui/spinner"
import { FlashPayReceiptCard } from "@/components/flashpay-receipt-card"
import { config } from "@/lib/config"
import { getReceiptLink } from "@/lib/router"
import type { FlashPayReceiptView } from "@/lib/types"
import { Printer } from "lucide-react"
import { useUnifiedStore } from "@/lib/unified-store"

export default function ReceiptPage() {
  const params = useParams()
  const router = useRouter()
  const receiptId = params.id as string
  const [receipt, setReceipt] = useState<FlashPayReceiptView | null>(null)
  const [loading, setLoading] = useState(true)
  const store = useUnifiedStore()
  const merchant = store.getMerchantState()

  useEffect(() => {
    const fetchReceipt = async () => {
      try {
        setLoading(true)
        const headers: HeadersInit = { "Content-Type": "application/json" }
        if (merchant?.accessToken) headers.Authorization = `Bearer ${merchant.accessToken}`
        const response = await fetch(`${config.appUrl}/api/receipts/${encodeURIComponent(receiptId)}`, { headers })
        if (response.ok) {
          const nextReceipt = await response.json() as FlashPayReceiptView
          setReceipt(nextReceipt)
          if (nextReceipt.flashPayPaymentId && nextReceipt.flashPayPaymentId !== receiptId) {
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
          <div className="mt-6 rounded-lg border p-6 text-center text-muted-foreground">Receipt not found or not available yet.</div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background pb-20 print:bg-white">
      <div className="max-w-2xl mx-auto px-4 pb-4 pt-12 space-y-5 print:p-0">
        <div className="flex items-center justify-between print:hidden">
          <h1 className="text-2xl font-bold">Receipt</h1>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" /> Print
            </Button>
            <BackButton />
          </div>
        </div>
        <FlashPayReceiptCard receipt={receipt} accessToken={merchant?.accessToken ?? null} />
      </div>
    </main>
  )
}
