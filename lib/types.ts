export type PaymentStatus = "PENDING" | "PAID" | "FAILED" | "CANCELLED"

export interface Payment {
  id: string
  merchantId: string // Required: Links payment to specific merchant
  merchantAddress?: string // Optional: Pi wallet address where payment is sent
  merchantUid?: string // CRITICAL: Pi user UID for A2U transfers (replaces wallet address)
  amount: number
  note: string
  status: PaymentStatus
  createdAt: Date
  paidAt?: Date
  txid?: string
}

// Transaction types — permanent ledger of all movements
export type TransactionType = "payment" | "settlement" | "refund" | "adjustment"
export type TransactionStatus = "pending" | "completed" | "failed"

export interface Transaction {
  transactionId: string
  type: TransactionType
  
  // Counterparties
  fromId: string
  fromType: "merchant" | "customer"
  toId?: string
  toType?: "merchant" | "customer"
  
  // Amount and currency
  amount: number
  currency: "π"
  
  // Linking back to original payment
  paymentId: string
  
  // Metadata
  description: string
  reference: string // human-readable like PAY-2024-00001
  
  // Timing
  createdAt: Date
  completedAt?: Date
  
  // Status
  status: TransactionStatus
}

export interface Receipt {
  receiptId: string
  transactionId: string
  merchantId: string
  
  // Merchant details snapshot
  merchant: {
    id: string
    name: string
    walletAddress?: string
  }
  
  // Payer details (if available)
  payer: {
    username?: string
    address?: string
  }
  
  // Payment details
  amount: number
  currency: "π"
  description: string
  reference: string
  
  // Blockchain details
  timestamp: Date
  txid?: string
  piPaymentId?: string
  
  // Additional metadata
  metadata?: {
    notes?: string
    [key: string]: unknown
  }
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

export interface MerchantBalance {
  merchantId: string
  settled: number
  unsettled: number
  total: number
  lastUpdated: Date
}
