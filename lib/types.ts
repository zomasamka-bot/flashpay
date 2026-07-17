export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled"

export interface Payment {
  id: string
  merchantId: string // Required: Links payment to specific merchant
  merchantAddress?: string // Optional: Pi wallet address where payment is sent
  merchantUid?: string // CRITICAL: Pi user UID for A2U transfers (replaces wallet address)
  accessToken: string // CRITICAL: Needed to verify uid at time of A2U settlement
  amount: number
  note: string
  status: PaymentStatus
  createdAt: string
  paidAt?: string
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
  
  // Timing - stored and transmitted as ISO strings
  createdAt: string
  completedAt?: string
  
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
  
  // Blockchain details - stored and transmitted as ISO string
  timestamp: string
  txid?: string
  piPaymentId?: string
  
  // U2A and A2U identifiers
  u2aIdentifier?: string  // User-to-App payment identifier
  u2aTxid?: string        // U2A transaction ID
  a2uIdentifier?: string  // App-to-User payment identifier
  a2uTxid?: string        // A2U transaction ID
  
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
  lastUpdated: string
}

export interface SettlementRequest {
  id: string
  merchant_id: string
  transaction_id: string
  amount: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  created_at: string
  completed_at?: string
  txid?: string
  error_message?: string
  retry_count: number
  payment_id?: string
}

// Database row types - represent actual schema returned from queries
export interface TransactionRow {
  id: string
  merchant_id: string
  type: string
  from_id: string
  from_type: string
  to_id?: string
  to_type?: string
  amount: number
  currency: string
  payment_id: string
  description: string
  reference: string
  created_at: string
  completed_at?: string
  status: string
}

export interface ReceiptRow {
  receipt_id?: string
  id?: string
  transaction_id: string
  merchant_id: string
  merchant_name?: string
  merchant_wallet_address?: string
  payer_username?: string
  payer_address?: string
  amount: number
  currency: string
  description: string
  reference: string
  timestamp?: string
  created_at?: string
  txid?: string
  pi_payment_id?: string
  u2a_identifier?: string
  u2a_txid?: string
  a2u_identifier?: string
  a2u_txid?: string
}

export interface MerchantBalanceRow {
  merchant_id: string
  settled: number
  unsettled: number
  last_updated?: string
}

// ============================================================================
// RUNTIME VALIDATORS FOR REDIS DATA
// ============================================================================

/**
 * Validate ISO 8601 date string
 */
function isValidISODate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const date = new Date(value)
    return !isNaN(date.getTime()) && value === date.toISOString()
  } catch {
    return false
  }
}

/**
 * Validate finite number
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value)
}

/**
 * Validate TransactionType
 */
function isTransactionType(value: unknown): value is TransactionType {
  return typeof value === 'string' && ['payment', 'settlement', 'refund', 'adjustment'].includes(value)
}

/**
 * Validate TransactionStatus
 */
function isTransactionStatus(value: unknown): value is TransactionStatus {
  return typeof value === 'string' && ['pending', 'completed', 'failed'].includes(value)
}

/**
 * Validate user type (merchant or customer)
 */
function isUserType(value: unknown): value is 'merchant' | 'customer' {
  return typeof value === 'string' && ['merchant', 'customer'].includes(value)
}

/**
 * Parse and validate Transaction from Redis
 */
export function parseTransaction(data: unknown): Transaction | null {
  if (!data || typeof data !== 'object') return null
  
  const obj = data as Record<string, unknown>
  
  // Validate required string fields
  if (typeof obj.transactionId !== 'string') return null
  if (!isTransactionType(obj.type)) return null
  if (typeof obj.fromId !== 'string') return null
  if (!isUserType(obj.fromType)) return null
  if (typeof obj.paymentId !== 'string') return null
  if (typeof obj.description !== 'string') return null
  if (typeof obj.reference !== 'string') return null
  if (!isTransactionStatus(obj.status)) return null
  
  // Validate required numeric field
  if (!isFiniteNumber(obj.amount)) return null
  
  // Validate currency
  if (obj.currency !== 'π') return null
  
  // Validate dates - must be ISO strings
  if (!isValidISODate(obj.createdAt)) return null
  
  // Validate optional fields
  if (obj.toId !== undefined && typeof obj.toId !== 'string') return null
  if (obj.toType !== undefined && !isUserType(obj.toType)) return null
  if (obj.completedAt !== undefined && !isValidISODate(obj.completedAt)) return null
  
  // After validation, types are narrowed - no casts needed
  return {
    transactionId: obj.transactionId,
    type: obj.type,
    fromId: obj.fromId,
    fromType: obj.fromType,
    toId: obj.toId,
    toType: obj.toType,
    amount: obj.amount,
    currency: 'π',
    paymentId: obj.paymentId,
    description: obj.description,
    reference: obj.reference,
    createdAt: obj.createdAt,
    completedAt: obj.completedAt,
    status: obj.status,
  }
}

/**
 * Parse and validate Receipt from Redis
 */
export function parseReceipt(data: unknown): Receipt | null {
  if (!data || typeof data !== 'object') return null
  
  const obj = data as Record<string, unknown>
  
  // Validate required fields
  if (typeof obj.receiptId !== 'string') return null
  if (typeof obj.transactionId !== 'string') return null
  if (typeof obj.merchantId !== 'string') return null
  if (!isFiniteNumber(obj.amount)) return null
  if (typeof obj.description !== 'string') return null
  if (typeof obj.reference !== 'string') return null
  if (!isValidISODate(obj.timestamp)) return null
  
  // Validate currency
  if (obj.currency !== 'π') return null
  
  // Validate merchant object and all nested fields
  if (!obj.merchant || typeof obj.merchant !== 'object') return null
  const merchant = obj.merchant as Record<string, unknown>
  if (typeof merchant.id !== 'string' || typeof merchant.name !== 'string') return null
  if (merchant.walletAddress !== undefined && typeof merchant.walletAddress !== 'string') return null
  
  // Validate payer object and all nested fields
  if (!obj.payer || typeof obj.payer !== 'object') return null
  const payer = obj.payer as Record<string, unknown>
  if (payer.username !== undefined && typeof payer.username !== 'string') return null
  if (payer.address !== undefined && typeof payer.address !== 'string') return null
  
  // Validate optional fields
  if (obj.txid !== undefined && typeof obj.txid !== 'string') return null
  if (obj.piPaymentId !== undefined && typeof obj.piPaymentId !== 'string') return null
  if (obj.u2aIdentifier !== undefined && typeof obj.u2aIdentifier !== 'string') return null
  if (obj.u2aTxid !== undefined && typeof obj.u2aTxid !== 'string') return null
  if (obj.a2uIdentifier !== undefined && typeof obj.a2uIdentifier !== 'string') return null
  if (obj.a2uTxid !== undefined && typeof obj.a2uTxid !== 'string') return null
  
  // After validation, no casts needed
  return {
    receiptId: obj.receiptId,
    transactionId: obj.transactionId,
    merchantId: obj.merchantId,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      walletAddress: merchant.walletAddress,
    },
    payer: {
      username: payer.username,
      address: payer.address,
    },
    amount: obj.amount,
    currency: 'π',
    description: obj.description,
    reference: obj.reference,
    timestamp: obj.timestamp,
    txid: obj.txid,
    piPaymentId: obj.piPaymentId,
    u2aIdentifier: obj.u2aIdentifier,
    u2aTxid: obj.u2aTxid,
    a2uIdentifier: obj.a2uIdentifier,
    a2uTxid: obj.a2uTxid,
  }
}

/**
 * Parse and validate MerchantBalance from Redis
 */
export function parseMerchantBalance(data: unknown, merchantId: string): MerchantBalance | null {
  if (!data || typeof data !== 'object') return null
  
  const obj = data as Record<string, unknown>
  
  // Validate required string and verify merchantId identity
  if (typeof obj.merchantId !== 'string' || obj.merchantId !== merchantId) return null
  
  // Validate required numbers
  if (!isFiniteNumber(obj.settled)) return null
  if (!isFiniteNumber(obj.unsettled)) return null
  if (!isFiniteNumber(obj.total)) return null
  
  // Validate optional date
  if (obj.lastUpdated !== undefined && !isValidISODate(obj.lastUpdated)) return null
  
  // After validation, no casts needed
  return {
    merchantId: obj.merchantId,
    settled: obj.settled,
    unsettled: obj.unsettled,
    total: obj.total,
    lastUpdated: obj.lastUpdated || new Date().toISOString(),
  }
}
