"use client"

import type { RefundPresentation } from "@/lib/types"

type Props = {
  presentation?: RefundPresentation
  status: "loading" | "ready" | "indeterminate"
}

function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="ml-2 shrink-0 text-xs font-semibold text-blue-700 underline underline-offset-2"
      onClick={() => void navigator.clipboard.writeText(value)}
    >
      Copy
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
        <span className="min-w-0 break-all">{text}</span>
        {copyable && <CopyButton value={text} />}
      </dd>
    </div>
  )
}

export default function CustomerRefundStatusCard({ presentation, status }: Props) {
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
    refund_completed: "Refund completed — Your refund has been returned to your Pi Wallet. Open Pi Wallet to view the transaction.",
    refund_delayed: "Refund status cannot be verified yet.",
  }[presentation.customerStatus]

  const receiptFields = [
    ["Amount", `${presentation.amount} ${presentation.currency}`],
    ["Payment ID", presentation.paymentId],
    ["Refund ID", presentation.refundId],
    ["Refund payment ID", presentation.refundPaymentId],
    ["Refund transaction ID", presentation.refundTxid],
    ["Network", presentation.blockchain.network],
    ["Requested at", formatLocalDateTime(presentation.requestedAt)],
    ["Blockchain transaction at", formatLocalDateTime(presentation.blockchain.transactionAt)],
    ["Completed at", formatLocalDateTime(presentation.finalization.completedAt)],
    ["Finalized at", formatLocalDateTime(presentation.finalization.finalizedAt)],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "")

  const copyReceipt = () =>
    void navigator.clipboard.writeText(receiptFields.map(([label, value]) => `${label}: ${String(value)}`).join("\\n"))

  return (
    <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="border-b border-slate-200 pb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Refund status</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">{statusLabel}</h2>
        <button
          type="button"
          className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
          onClick={copyReceipt}
        >
          Copy receipt
        </button>
      </header>
      <dl className="mt-2">
        <Detail label="Amount" value={`${presentation.amount} ${presentation.currency}`} />
        <Detail label="Payment ID" value={presentation.paymentId} copyable />
        <Detail label="Refund ID" value={presentation.refundId} copyable />
        <Detail label="Refund payment ID" value={presentation.refundPaymentId} copyable />
        <Detail label="Refund transaction ID" value={presentation.refundTxid} copyable />
        <Detail label="Network" value={presentation.blockchain.network} />
        <Detail label="Requested at" value={formatLocalDateTime(presentation.requestedAt)} />
        <Detail label="Blockchain transaction at" value={formatLocalDateTime(presentation.blockchain.transactionAt)} />
        <Detail label="Completed at" value={formatLocalDateTime(presentation.finalization.completedAt)} />
        <Detail label="Finalized at" value={formatLocalDateTime(presentation.finalization.finalizedAt)} />
      </dl>
    </section>
  )
}

export type { Props as CustomerRefundStatusCardProps }
