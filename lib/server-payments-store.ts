/**
 * Server-side payment store
 * Shared in-memory storage for development
 * Replace with persistent database in production
 */

interface Payment {
  id: string
  merchantId?: string
  amount: number
  note: string
  status: "pending" | "paid" | "failed" | "cancelled"
  createdAt: string
  paidAt?: string
  txid?: string
}

class ServerPaymentsStore {
  private payments = new Map<string, Payment>()

  set(id: string, payment: Payment): void {
    console.log("[ServerStore] Setting payment:", id)
    this.payments.set(id, payment)
  }

  get(id: string): Payment | undefined {
    const payment = this.payments.get(id)
    console.log("[ServerStore] Getting payment:", id, payment ? "found" : "not found")
    return payment
  }

  has(id: string): boolean {
    return this.payments.has(id)
  }

  delete(id: string): boolean {
    return this.payments.delete(id)
  }

  getAll(): Payment[] {
    return Array.from(this.payments.values())
  }

  clear(): void {
    this.payments.clear()
  }
}

// Export singleton instance
export const serverPaymentsStore = new ServerPaymentsStore()
