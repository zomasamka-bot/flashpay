import { query } from "./db"
import { Payment } from "./types"
import { randomUUID } from "crypto"

/**
 * Generate a human-readable transaction reference
 * Format: PAY-YYYY-NNNNN (e.g., PAY-2024-ABC123)
 */
function generateReference(): string {
  const year = new Date().getFullYear()
  const random = Math.random().toString(36).substring(2, 8).toUpperCase()
  return `PAY-${year}-${random}`
}

/**
 * Record a transaction to PostgreSQL after payment completion
 * This is called fire-and-forget and does NOT block payment flow
 */
export async function recordTransactionToPG(
  payment: Payment,
  piPaymentId: string,
  txid?: string
): Promise<{ transactionId: string; reference: string } | null> {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) {
    console.log("[Transaction] PostgreSQL not configured, skipping")
    return null
  }

  // Validate required fields before processing
  if (!payment?.merchantId) {
    console.error("[Transaction] Invalid payment - missing merchantId")
    return null
  }

  if (!payment?.id) {
    console.error("[Transaction] Invalid payment - missing id")
    return null
  }

  if (typeof payment.amount !== "number" || payment.amount <= 0) {
    console.error("[Transaction] Invalid payment - invalid amount:", payment.amount)
    return null
  }

  // Validate createdAt is a valid date
  let createdAtDate: Date
  try {
    if (payment.createdAt instanceof Date) {
      createdAtDate = payment.createdAt
    } else if (typeof payment.createdAt === "string") {
      createdAtDate = new Date(payment.createdAt)
    } else {
      createdAtDate = new Date()
    }
    
    if (isNaN(createdAtDate.getTime())) {
      console.error("[Transaction] Invalid createdAt date, using current time")
      createdAtDate = new Date()
    }
  } catch (error) {
    console.error("[Transaction] Date parsing error, using current time:", error)
    createdAtDate = new Date()
  }

  try {
    const transactionId = randomUUID()
    const reference = generateReference()
    
    console.log("[Transaction] Starting to record:", {
      transactionId,
      piPaymentId,
      merchantId: payment.merchantId,
      amount: payment.amount,
    })

    // Insert transaction with FULL field set including created_at
    console.log("[Transaction] About to insert transaction record...")
    const insertResult = await query(
      `INSERT INTO transactions (
        id, payment_id, merchant_id, amount, currency, 
        reference, description, status, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (payment_id) DO NOTHING
      RETURNING id`,
      [
        transactionId,
        piPaymentId,
        payment.merchantId,
        payment.amount,
        "π",
        reference,
        payment.note || "",
        "completed",
        createdAtDate.toISOString(),
      ]
    )
    
    if (!insertResult || insertResult.length === 0) {
      console.warn("[Transaction] Transaction insert returned no rows - may be duplicate or DB issue")
      return null
    }
    
    console.log("[Transaction] Transaction inserted successfully:", transactionId)

    // Insert receipt (linked to transaction)
    console.log("[Transaction] About to insert receipt...")
    const receiptResult = await query(
      `INSERT INTO receipts (
        transaction_id, merchant_id, amount, currency,
        timestamp, txid, metadata, created_at
      ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, NOW())
      RETURNING id`,
      [
        transactionId,
        payment.merchantId,
        payment.amount,
        "π",
        txid || "",
        JSON.stringify({
          paymentId: piPaymentId,
          piPaymentId: piPaymentId,
          createdAt: createdAtDate.toISOString(),
          paidAt: new Date().toISOString(),
        }),
      ]
    )
    
    if (!receiptResult || receiptResult.length === 0) {
      console.warn("[Transaction] Receipt insert returned no rows - may be duplicate")
    } else {
      console.log("[Transaction] Receipt inserted successfully:", transactionId)
    }

    // Update merchant balance (unsettled)
    console.log("[Transaction] About to update merchant balance for:", payment.merchantId)
    const balanceResult = await query(
      `INSERT INTO merchant_balances (
        merchant_id, settled, unsettled, last_updated
      ) VALUES ($1, 0, $2, NOW())
      ON CONFLICT (merchant_id) DO UPDATE
      SET 
        unsettled = merchant_balances.unsettled + $2,
        last_updated = NOW()
      RETURNING merchant_id`,
      [payment.merchantId, payment.amount]
    )
    
    if (!balanceResult || balanceResult.length === 0) {
      console.warn("[Transaction] Balance update returned no rows")
    } else {
      console.log("[Transaction] Merchant balance updated successfully:", payment.merchantId)
    }

    console.log("[Transaction] Recorded successfully:", {
      transactionId,
      reference,
      merchantId: payment.merchantId,
      amount: payment.amount,
    })

    return { transactionId, reference }
  } catch (error) {
    console.error("[Transaction] Recording failed (non-blocking):", error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Check if a transaction already exists (for duplicate prevention)
 */
export async function transactionExists(piPaymentId: string): Promise<boolean> {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) return false

  try {
    const result = await query(
      "SELECT id FROM transactions WHERE payment_id = $1 LIMIT 1",
      [piPaymentId]
    )
    return result && result.length > 0
  } catch (error) {
    console.error("[Transaction] Check failed:", error)
    return false
  }
}

/**
 * Get transaction count for a merchant
 */
export async function getMerchantTransactionCount(merchantId: string): Promise<number> {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) return 0

  try {
    const result = await query(
      "SELECT COUNT(*) as count FROM transactions WHERE merchant_id = $1",
      [merchantId]
    )
    return result && result.length > 0 ? parseInt(result[0].count, 10) : 0
  } catch (error) {
    console.error("[Transaction] Count failed:", error)
    return 0
  }
}

/**
 * Get total volume for a merchant
 */
export async function getMerchantVolume(merchantId: string): Promise<number> {
  const isConfigured = !!process.env.DATABASE_URL
  if (!isConfigured) return 0

  try {
    const result = await query(
      "SELECT SUM(amount)::numeric as total FROM transactions WHERE merchant_id = $1 AND status = 'completed'",
      [merchantId]
    )
    return result && result.length > 0 ? parseFloat(result[0].total || 0) : 0
  } catch (error) {
    console.error("[Transaction] Volume calculation failed:", error)
    return 0
  }
}
