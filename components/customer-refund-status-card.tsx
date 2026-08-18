import type { RefundPresentation } from "@/lib/types"

type Props = {
  presentation?: RefundPresentation
  status: "loading" | "ready" | "indeterminate"
}

function Detail({ label, value }: { label: string; value?: string | number | null }) {
  if (value === undefined || value === null || value === "") return null
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 last:border-b-0">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="max-w-[65%] break-words text-right text-sm font-medium text-slate-900">{String(value)}</dd>
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
    refund_pending: "Refund in progress",
    refund_confirmed: "Refund confirmed on Pi Testnet; final records pending",
    refund_completed: "Refund completed",
    refund_delayed: "Refund status cannot be verified yet.",
  }[presentation.customerStatus]

  return (
    <section aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="border-b border-slate-200 pb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Refund status</p>
        <h2 className="mt-2 text-lg font-semibold text-slate-950">{statusLabel}</h2>
      </header>
      <dl className="mt-2">
        <Detail label="Amount" value={`${presentation.amount} ${presentation.currency}`} />
        <Detail label="Payment ID" value={presentation.paymentId} />
        <Detail label="Refund ID" value={presentation.refundId} />
        <Detail label="Refund payment ID" value={presentation.refundPaymentId} />
        <Detail label="Refund transaction ID" value={presentation.refundTxid} />
        <Detail label="Network" value={presentation.blockchain.network} />
        <Detail label="Requested at" value={presentation.requestedAt} />
        <Detail label="Blockchain transaction at" value={presentation.blockchain.transactionAt} />
        <Detail label="Completed at" value={presentation.finalization.completedAt} />
        <Detail label="Finalized at" value={presentation.finalization.finalizedAt} />
      </dl>
    </section>
  )
}

export type { Props as CustomerRefundStatusCardProps }
