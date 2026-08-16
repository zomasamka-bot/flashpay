export type PaymentStatus = "pending" | "paid_to_app" | "settlement_pending" | "settled_to_merchant" | "settlement_failed" | "failed" | "cancelled" | "refund_pending" | "refunded"
export type SettlementFailureState = "none" | "retryable" | "reconciling" | "held" | "manual_review_required" | "refund_pending" | "refunded"

export interface Payment {
  id: string
  merchantId: string // Required: Links payment to specific merchant
  merchantAddress?: string // Optional: Pi wallet address where payment is sent
  merchantUid?: string // CRITICAL: Pi user UID for A2U transfers (replaces wallet address)
  accessToken: string // CRITICAL: Needed to verify uid at time of A2U settlement
  
  // Amount tracking - CRITICAL for fee accounting
  amount: number // Customer amount paid (U2A)
  customerAmount?: number // Verified U2A amount (for explicit tracking)
  merchantAmount?: number // Actual amount in A2U blockchain transfer
  horizonFeeCharged?: number // Actual Horizon fee in Pi (stroops / 1e7)
  appCommission?: number // App commission (default 0)
  appNetImpact?: number // What app absorbs (customerAmount - merchantAmount - horizonFeeCharged)
  
  note: string
  status: PaymentStatus
  settlementStage?: "pending_signing" | "sign_pending" | "complete_pending" | "completed" // Internal step tracking - NOT public status
  createdAt: string
  paidAt?: string // When U2A was marked paid_to_app
  settledAt?: string // When A2U settled_to_merchant (only set when status=settled_to_merchant)
  
  // U2A recovery tracking
  piPaymentId?: string // U2A identifier from Pi webhook
  u2aTxid?: string // U2A transaction ID (customer-to-app txid)
  
  // A2U recovery for atomic idempotency
  a2uPaymentId?: string // Pi A2U identifier - stored after Horizon succeeds
  a2uTxid?: string // Horizon transaction ID
  a2uFromAddress?: string // Stellar account from address
  a2uToAddress?: string // Stellar account to address
  
  // Recovery state flags
  requiresDbReconciliation?: boolean // True if A2U succeeded but DB record needs creation/update
  horizonSuccessFlag?: boolean // True if Horizon submitTransaction succeeded
  horizonSuccessAt?: string // ISO timestamp when Horizon succeeded
  piCompletionPending?: boolean // True if Horizon succeeded but Pi /complete not yet called
  piCompleted?: boolean // True if Pi /complete succeeded
  dbRecorded?: boolean // True if transaction successfully recorded in database

  // Settlement failure and refund safety (canonical operational checkpoint)
  a2uErrorCode?: string
  a2uErrorMessage?: string
  a2uErrorBody?: string
  retryCount?: number
  lastAttemptAt?: string
  nextRetryAt?: string
  settlementFailureState?: SettlementFailureState
  payerUid?: string
  payerUidSource?: "verified_u2a" | "pi_payment" | "manual_review"
  payerUidCapturedAt?: string
  payerRefundEligible?: boolean
  refundPaymentId?: string
  refundTxid?: string
  refundStatus?: "not_started" | "pending" | "submitted" | "completed" | "failed" | "manual_review_required"
  refundFailureCode?: string
  refundProof?: string
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
  
  // Receipt fields (from LEFT JOIN via /api/transactions)
  settlementStatus?: PaymentStatus
  piPaymentId?: string
  u2aIdentifier?: string
  u2aTxid?: string
  a2uPaymentId?: string
  a2uIdentifier?: string
  a2uTxid?: string
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
  
  // Payment details - CUSTOMER AMOUNT (what customer actually paid)
  customerAmount: number // Amount paid by customer from U2A (before Horizon fees)
  currency: "π"
  description: string
  reference: string
  
  // Fee and accounting breakdown - CRITICAL FOR MERCHANT SETTLEMENT
  horizonFeeCharged?: number // Horizon fee in Pi (stroops / 1e7) - charged from customer amount
  appCommission?: number // App commission (default 0) - deducted from customer amount
  merchantAmount: number // Amount to merchant (customerAmount - horizonFee - appCommission)
  appNetImpact: number // Net app wallet impact (horizonFee + appCommission) - what app retains
  
  // Legacy field for backward compatibility
  amount?: number // Deprecated - use customerAmount instead
  
  // Blockchain details - stored and transmitted as ISO string
  timestamp: string
  txid?: string // U2A transaction ID
  piPaymentId?: string // U2A payment identifier
  
  // U2A and A2U transaction IDs for tracing
  u2aTxid?: string        // U2A transaction ID from Pi
  a2uTxid?: string        // A2U transaction ID (Horizon txid)
  
  // Settlement status
  settlementStatus?: PaymentStatus
  a2uPaymentId?: string        // A2U payment identifier
  settledAt?: string // When A2U transfer settled
  
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
  settlement_status?: PaymentStatus
}

export interface TransactionWithReceiptRow extends TransactionRow {
  // Receipt fields from LEFT JOIN - real column names
  settlement_status?: string
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
// REFUND SAFETY CONTRACTS
// ============================================================================

/**
 * Refund lifecycle states. A refund may only move forward through this
 * lifecycle; terminal states are completed, failed, or manual review.
 */
export type RefundStatus =
  | "not_started"
  | "pending"
  | "submitted"
  | "completed"
  | "failed"
  | "manual_review_required"

export type RefundCheckpointStage =
  | "eligibility_verified"
  | "intent_created"
  | "wallet_submission_started"
  | "wallet_submission_confirmed"
  | "payment_checkpoint_updated"
  | "accounting_recorded"
  | "audit_recorded"

/** Durable, idempotent checkpoint for one refund attempt. */
export interface RefundCheckpoint {
  refundId: string
  paymentId: string
  idempotencyKey: string
  status: RefundStatus
  stage: RefundCheckpointStage
  payerUid: string
  payerUidVerifiedAt: string
  amount: number
  currency: "π"
  sourcePaymentStatus: PaymentStatus
  sourceSettlementState: SettlementFailureState
  createdAt: string
  updatedAt: string
  refundPaymentId?: string
  refundTxid?: string
  attemptCount: number
  lastErrorCode?: string
  lastErrorMessage?: string
  nextRetryAt?: string
}

/** Append-only audit event for refund decisions and external effects. */
export interface RefundAuditEvent {
  eventId: string
  refundId: string
  paymentId: string
  eventType:
    | "eligibility_verified"
    | "refund_requested"
    | "refund_submission_started"
    | "refund_payment_identified"
    | "refund_blockchain_submission_started"
    | "refund_submission_confirmed"
    | "refund_payment_checkpoint_updated"
    | "refund_accounting_recorded"
    | "refund_audit_recorded"
    | "refund_rejected"
    | "refund_completed"
    | "refund_projection_finalized"
    | "refund_manual_review"
  actorType: "system" | "merchant" | "customer" | "operator"
  idempotencyKey: string
  createdAt: string
  details: Record<string, string | number | boolean | null>
}

export type RefundPresentationState = "pending" | "blockchain_confirmed" | "completed" | "attention_required"
export type CustomerRefundStatus = "refund_pending" | "refund_confirmed" | "refund_completed" | "refund_delayed"
export type MerchantRefundStatus = "refund_pending" | "refund_confirmed" | "refund_completed" | "refund_attention_required"
export interface RefundPresentation {
  paymentId: string
  refundId: string
  amount: number
  currency: "π"
  refundStatus: RefundStatus
  refundStage: RefundCheckpointStage
  refundPaymentId?: string
  refundTxid?: string
  createdAt: string
  requestedAt: string | null
  blockchain: {
    confirmed: boolean
    network: "Pi Testnet" | null
    confirmationRecordedAt: string | null
    transactionAt: string | null
    piTransactionVerified: boolean | null
    piDeveloperCompleted: boolean | null
    horizonSuccessful: boolean | null
  }
  finalization: {
    accountingRecorded: boolean
    accountingRecordedAt: string | null
    auditRecorded: boolean
    auditRecordedAt: string | null
    completionAuditRecorded: boolean
    completedAt: string | null
    projectionFinalized: boolean
    finalizedAt: string | null
  }
  state: RefundPresentationState
  customerStatus: CustomerRefundStatus
  merchantStatus: MerchantRefundStatus
}

/**
 * Phase 1 invariant guard. This is intentionally pure and has no side
 * effects; execution paths will use it before any refund work is added.
 */
/**
 * The only trusted transition into refund eligibility. Callers must invoke
 * this after verified U2A identity capture and a failed, non-successful A2U
 * attempt; it never permits a Horizon-successful payment to become refundable.
 */
export function markRefundPendingAfterFailedSettlement(
  payment: Payment,
  failure: { code: string; message?: string; occurredAt: string },
): Payment {
  if (
    payment.status !== "settlement_failed" ||
    payment.payerUidSource !== "verified_u2a" ||
    !payment.payerUid ||
    !payment.payerUidCapturedAt ||
    payment.a2uPaymentId ||
    payment.a2uTxid ||
    payment.horizonSuccessFlag === true
  ) return payment
  return {
    ...payment,
    status: "settlement_failed",
    settlementFailureState: "refund_pending",
    payerRefundEligible: true,
    a2uErrorCode: failure.code,
    a2uErrorMessage: failure.message,
    lastAttemptAt: failure.occurredAt,
    refundStatus: "pending",
  }
}

export function isRefundEligible(payment: Payment): boolean {
  return (
    payment.status === "settlement_failed" &&
    payment.settlementFailureState === "refund_pending" &&
    payment.payerRefundEligible === true &&
    payment.payerUidSource === "verified_u2a" &&
    typeof payment.payerUidCapturedAt === "string" &&
    payment.payerUidCapturedAt.length > 0 &&
    typeof payment.payerUid === "string" &&
    payment.payerUid.length > 0 &&
    !payment.a2uPaymentId &&
    !payment.a2uTxid &&
    !payment.refundPaymentId &&
    !payment.refundTxid &&
    payment.horizonSuccessFlag !== true &&
    typeof payment.customerAmount === "number" &&
    Number.isFinite(payment.customerAmount) &&
    payment.customerAmount > 0 &&
    payment.refundStatus !== "completed" &&
    payment.refundStatus !== "submitted"
  )
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
    if (isNaN(date.getTime())) return false
    // Accept value if it parses to valid ISO date - don't require exact toISOString() match
    // Redis may store dates in slightly different ISO formats
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
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
 * REQUIRED canonical fields: customerAmount, merchantAmount, appNetImpact
 * OPTIONAL backward-compat: amount (deprecated)
 */
export function parseReceipt(data: unknown): Receipt | null {
  if (!data || typeof data !== 'object') return null
  
  const obj = data as Record<string, unknown>
  
  // Validate required string fields
  if (typeof obj.receiptId !== 'string') return null
  if (typeof obj.transactionId !== 'string') return null
  if (typeof obj.merchantId !== 'string') return null
  if (typeof obj.description !== 'string') return null
  if (typeof obj.reference !== 'string') return null
  if (!isValidISODate(obj.timestamp)) return null
  
  // Validate currency
  if (obj.currency !== 'π') return null
  
  // Validate REQUIRED canonical numeric fields
  if (!isFiniteNumber(obj.customerAmount)) return null
  if (!isFiniteNumber(obj.merchantAmount)) return null
  if (!isFiniteNumber(obj.appNetImpact)) return null
  
  // Validate optional numeric fields (can be undefined, but if present must be finite)
  if (obj.horizonFeeCharged !== undefined && !isFiniteNumber(obj.horizonFeeCharged)) return null
  if (obj.appCommission !== undefined && !isFiniteNumber(obj.appCommission)) return null
  if (obj.amount !== undefined && !isFiniteNumber(obj.amount)) return null // Deprecated field
  
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
  
  // Validate optional transaction ID fields
  if (obj.txid !== undefined && typeof obj.txid !== 'string') return null
  if (obj.piPaymentId !== undefined && typeof obj.piPaymentId !== 'string') return null
  if (obj.u2aTxid !== undefined && typeof obj.u2aTxid !== 'string') return null
  if (obj.a2uPaymentId !== undefined && typeof obj.a2uPaymentId !== 'string') return null
  if (obj.a2uTxid !== undefined && typeof obj.a2uTxid !== 'string') return null
  
  // Validate optional settlement fields using PaymentStatus values
  const VALID_PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid_to_app', 'settlement_pending', 'settled_to_merchant', 'settlement_failed', 'failed', 'cancelled']
  let settlementStatus: PaymentStatus | undefined = undefined
  if (obj.settlementStatus !== undefined) {
    if (!VALID_PAYMENT_STATUSES.includes(obj.settlementStatus as PaymentStatus)) return null
    settlementStatus = obj.settlementStatus as PaymentStatus
  }
  if (obj.settledAt !== undefined && !isValidISODate(obj.settledAt)) return null
  
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
    customerAmount: obj.customerAmount,
    merchantAmount: obj.merchantAmount,
    appNetImpact: obj.appNetImpact,
    horizonFeeCharged: obj.horizonFeeCharged,
    appCommission: obj.appCommission,
    amount: obj.amount, // Deprecated
    currency: 'π',
    description: obj.description,
    reference: obj.reference,
    timestamp: obj.timestamp,
    txid: obj.txid,
    piPaymentId: obj.piPaymentId,
    u2aTxid: obj.u2aTxid,
    a2uPaymentId: obj.a2uPaymentId as string | undefined,
    a2uTxid: obj.a2uTxid,
    settlementStatus,
    settledAt: obj.settledAt,
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
