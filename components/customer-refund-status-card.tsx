"use client"

import type { RefundPresentation } from "@/lib/types"
import { useState } from "react"
import { useI18n } from "@/components/i18n-provider"

type Props = {
  presentation?: RefundPresentation
  status: "loading" | "ready" | "indeterminate"
  audience?: "customer" | "merchant"
}

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Pi Browser/WebViews can expose Clipboard API but reject writes.
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

function CopyButton({ value }: { value: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!(await copyText(value))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <button
      type="button"
      className="ml-2 shrink-0 text-xs font-semibold text-blue-700 underline underline-offset-2"
      onClick={() => void handleCopy()}
      aria-label={t("receipt.copyId")}
    >
      {copied ? t("common.copied") : t("common.copy")}
    </button>
  )
}

function formatLocalDateTime(locale: string, value?: string | number | null): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unavailable"
  const formatter = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  })
  return formatter.format(date)
}

function Detail({ label, value, copyable = false }: { label: string; value?: string | number | null; copyable?: boolean }) {
  if (value === undefined || value === null || value === "") return null
  const text = String(value)
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 last:border-b-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="flex min-w-0 max-w-[65%] items-start text-right text-sm font-medium text-slate-900">
        <span className={copyable ? "min-w-0 break-all" : "min-w-0 break-words"}>{text}</span>
        {copyable && <CopyButton value={text} />}
      </dd>
    </div>
  )
}

export default function CustomerRefundStatusCard({ presentation, status, audience = "customer" }: Props) {
  const [receiptCopied, setReceiptCopied] = useState(false)
  const { t, locale } = useI18n()

  if (status === "loading") {
    return (
      <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">{t("refund.loading")}</p>
      </section>
    )
  }

  if (status === "indeterminate" || !presentation) {
    return (
      <section aria-live="polite" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
        <h2 className="text-base font-semibold text-amber-950">{t("refund.unverified")}</h2>
        <p className="mt-2 text-sm text-amber-900">{t("refund.tryLater")}</p>
      </section>
    )
  }

  const statusLabel = presentation.customerStatus === "refund_completed"
    ? t(audience === "merchant" ? "refund.completedMerchant" : "refund.completedCustomer")
    : t(`refund.status.${presentation.customerStatus}`)

  const receiptFields = [
    [t("refund.amount"), `${presentation.amount} ${presentation.currency}`],
    [t("refund.flashpayId"), presentation.paymentId],
    [t("refund.statusLabel"), statusLabel],
    [t("refund.requestedAt"), formatLocalDateTime(locale, presentation.requestedAt)],
    [t("refund.completedAt"), formatLocalDateTime(locale, presentation.finalization.completedAt)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "")

  const copyReceipt = async () => {
    const copied = await copyText(receiptFields.map(([label, value]) => `${label}: ${String(value)}`).join("\n"))
    if (!copied) return
    setReceiptCopied(true)
    window.setTimeout(() => setReceiptCopied(false), 1800)
  }

  return (
    <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="border-b border-slate-200 pb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{t("refund.title")}</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">{statusLabel}</h2>
        <button
          type="button"
          className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
          onClick={() => void copyReceipt()}
        >
          {receiptCopied ? t("common.copied") : t("refund.copyStatus")}
        </button>
      </header>
      <dl className="mt-2">
        <Detail label={t("refund.amount")} value={`${presentation.amount} ${presentation.currency}`} />
        <Detail label={t("refund.flashpayId")} value={presentation.paymentId} copyable />
        <Detail label={t("refund.requestedAt")} value={formatLocalDateTime(locale, presentation.requestedAt)} />
        <Detail label={t("refund.completedAt")} value={formatLocalDateTime(locale, presentation.finalization.completedAt)} />
        <Detail label={t("refund.finalizedAt")} value={formatLocalDateTime(locale, presentation.finalization.finalizedAt)} />
      </dl>
    </section>
  )
}

export type { Props as CustomerRefundStatusCardProps }
