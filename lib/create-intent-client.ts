"use client"

// FIN-100B: only the opaque UUID and request identity are stored; never Pi credentials.
const KEY = "flashpay:pending-create-intent:v1"
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Pending = { id: string; merchantUid: string; merchantId: string; amount: number; note: string }

export function acquireCreateIntent(merchantUid: string, merchantId: string, amount: number, note: string): string {
  if (!merchantUid || !merchantId || !Number.isFinite(amount) || amount <= 0 || typeof window === "undefined") {
    throw new Error("Merchant identity or payment amount unavailable")
  }
  // Storage failure is indeterminate: do not create a new durable identity.
  const raw = window.localStorage.getItem(KEY)
  if (raw !== null) {
    let pending: Pending
    try { pending = JSON.parse(raw) as Pending } catch { throw new Error("Pending payment record is unreadable; creation blocked") }
    if (!pending || !UUID_V4.test(pending.id) || typeof pending.merchantUid !== "string" ||
        typeof pending.merchantId !== "string" || typeof pending.amount !== "number" || typeof pending.note !== "string") {
      throw new Error("Pending payment record is invalid; creation blocked")
    }
    if (pending.merchantUid !== merchantUid || pending.merchantId !== merchantId ||
        pending.amount !== amount || pending.note !== note) {
      throw new Error("An earlier payment request is unresolved. Reopen it with the original merchant and amount; do not create another request yet.")
    }
    return pending.id
  }
  const id = window.crypto.randomUUID()
  const record: Pending = { id, merchantUid, merchantId, amount, note }
  window.localStorage.setItem(KEY, JSON.stringify(record))
  if (window.localStorage.getItem(KEY) !== JSON.stringify(record)) {
    throw new Error("Could not persist payment request identity; creation blocked")
  }
  return id
}

export function finishCreateIntent(id: string): void {
  const raw = window.localStorage.getItem(KEY)
  if (!raw) return
  const current = JSON.parse(raw) as Pending
  if (current.id !== id) throw new Error("Pending payment identity changed; cannot clear")
  window.localStorage.removeItem(KEY)
}
