"use client"

import type { RefundPresentation } from "@/lib/types"
import { useState } from "react"

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
      aria-label="Copy FlashPay ID"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

const refundDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  numberingSystem: "latn",
})

function formatLocalDateTime(value?: string | number | null): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unavailable"
  const parts = Object.fromEntries(refundDateTimeFormatter.formatToParts(date).map(({ type, value }) => [type, value]))
  return `${parts.day} ${parts.month} ${parts.year} · ${parts.hour}:${parts.minute}:${parts.second}`
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

  if (status === "loading") {
    return (
      <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">Loading refund status…</p>
      </section>
    )
  }

  if (status === "indeterminate" || !presentation) {
    return (
      <section aria-live="polite" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
        <h2 className="text-base font-semibold text-amber-950">Refund status cannot be verified yet.</h2>
        <p className="mt-2 text-sm text-amber-900">Please try again later.</p>
      </section>
    )
  }

  const statusLabel = {
    refund_pending: "Your refund is being processed back to your Pi Wallet and usually appears there within about 3 minutes. Processing continues automatically, so you may safely leave this page. If you need a finalized refund receipt, please allow up to 10 minutes for the final records to complete.",
    refund_confirmed: "Your refund has been sent back through Pi. Open Pi Wallet to view the transaction; final records will continue automatically.",
    refund_completed:
      audience === "merchant"
        ? "Refund completed — The refund has been returned to the customer's Pi Wallet."
        : "Refund completed — Your refund has been returned to your Pi Wallet. Open Pi Wallet to view the transaction.",
    refund_delayed: "Refund status cannot be verified yet.",
  }[presentation.customerStatus]

  const receiptFields = [
    ["Amount", `${presentation.amount} ${presentation.currency}`],
    ["FlashPay ID", presentation.paymentId],
    ["Status", statusLabel],
    ["Requested at", formatLocalDateTime(presentation.requestedAt)],
    ["Completed at", formatLocalDateTime(presentation.finalization.completedAt)],
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
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Refund status</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">{statusLabel}</h2>
        <button
          type="button"
          className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
          onClick={() => void copyReceipt()}
        >
          {receiptCopied ? "Copied" : "Copy refund status"}
        </button>
      </header>
      <dl className="mt-2">
        <Detail label="Amount" value={`${presentation.amount} ${presentation.currency}`} />
        <Detail label="FlashPay ID" value={presentation.paymentId} copyable />
        <Detail label="Requested at" value={formatLocalDateTime(presentation.requestedAt)} />
        <Detail label="Completed at" value={formatLocalDateTime(presentation.finalization.completedAt)} />
        <Detail label="Finalized at" value={formatLocalDateTime(presentation.finalization.finalizedAt)} />
      </dl>
    </section>
  )
}

export type { Props as CustomerRefundStatusCardProps }
