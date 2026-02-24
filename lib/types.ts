export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "CANCELLED"

export interface Payment {
  id: string
  merchantId: string // Required: Links payment to specific merchant
  amount: number
  note: string
  status: PaymentStatus
  createdAt: Date
  paidAt?: Date
  txid?: string
}

export interface MerchantAnalytics {
  merchantId: string
  totalPayments: number
  paidPayments: number
  totalAmount: number
  firstPaymentDate?: Date
  lastPaymentDate?: Date
}

export interface GlobalAnalytics {
  totalMerchants: number
  totalPayments: number
  totalVolume: number
  activeMerchants: number
  merchantAnalytics: MerchantAnalytics[]
}
