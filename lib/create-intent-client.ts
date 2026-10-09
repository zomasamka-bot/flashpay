"use client"

// FIN-100B: only the opaque UUID and request identity are stored; never Pi credentials.
const KEY = "flashpay:pending-create-intent:v1"
const LOCK = "flashpay:create-intent:v1"
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Pending = { id: string; merchantUid: string; merchantId: string; amount: number; note: string }

// localStorage's read-then-write is not a cross-tab compare-and-swap. The
// exclusive origin-scoped Web Lock serializes identity acquisition and release.
// Without this primitive, fail closed rather than mint independent identities.
async function withIntentLock<T>(action: () => T): Promise<T> {
  if (typeof window === "undefined" || !window.navigator?.locks?.request) {
    throw new Error("Safe cross-tab payment creation is unavailable in this browser; creation blocked")
  }
  return window.navigator.locks.request(LOCK, { mode: "exclusive" }, action)
}

export async function acquireCreateIntent(merchantUid: string, merchantId: string, amount: number, note: string): Promise<string> {
  if (!merchantUid || !merchantId || !Number.isFinite(amount) || amount <= 0 || typeof note !== "string") {
    throw new Error("Merchant identity or payment amount unavailable")
  }
  return withIntentLock(() => {
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
    if (!UUID_V4.test(id)) throw new Error("Payment identity generation failed; creation blocked")
    const serialized = JSON.stringify({ id, merchantUid, merchantId, amount, note } satisfies Pending)
    window.localStorage.setItem(KEY, serialized)
    if (window.localStorage.getItem(KEY) !== serialized) {
      throw new Error("Could not persist payment request identity; creation blocked")
    }
    return id
  })
}

export async function finishCreateIntent(id: string): Promise<void> {
  await withIntentLock(() => {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return // Another tab may already have acknowledged this same intent.
    let current: Pending
    try { current = JSON.parse(raw) as Pending } catch { throw new Error("Pending payment identity unreadable; cannot clear") }
    if (current.id !== id) throw new Error("Pending payment identity changed; cannot clear")
    window.localStorage.removeItem(KEY)
    if (window.localStorage.getItem(KEY) !== null) {
      throw new Error("Pending payment identity could not be cleared")
    }
  })
}
