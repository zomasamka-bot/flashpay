/**
 * Transaction Service — handles recording, indexing, and retrieving transactions
 * This layer is independent from the payment system and won't affect payment completion
 */

import { redis, isRedisConfigured } from "./redis"
import { type Transaction, type Receipt, type Payment, type MerchantBalance } from "./types"
import { randomUUID } from "crypto"

/**
 * Generate a human-readable transaction reference
 * Format: PAY-YYYY-NNNNN where NNNNN is a sequential counter per merchant
 */
async function generateTransactionReference(merchantId: string): Promise<string> {
  if (!isRedisConfigured) return `TXN-${Date.now()}`

  const year = new Date().getFullYear()
  const counterKey = `merchant:${merchantId}:txn-counter:${year}`

  // Increment counter for this merchant in this year
  const counter = await redis.incr(counterKey)

  // Set expiry to ensure counter resets each year
  await redis.expire(counterKey, 365 * 24 * 60 * 60)

  return `PAY-${year}-${String(counter).padStart(5, "0")}`
}

/**
 * Record a transaction after payment completion
 * Called AFTER payment is marked PAID
 * Non-blocking: errors won't affect payment completion
 */
export async function recordTransaction(
  payment: Payment,
  piPaymentId: string,
  txid: string,
): Promise<Transaction | null> {
  if (!isRedisConfigured) {
    console.warn("[Transaction Service] Redis not configured, skipping transaction record")
    return null
  }

  // Validate required fields before processing
  if (!payment?.merchantId) {
    console.error("[Transaction Service] Invalid payment - missing merchantId")
    return null
  }

  if (!payment?.id) {
    console.error("[Transaction Service] Invalid payment - missing id")
    return null
  }

  if (typeof payment.amount !== "number" || payment.amount <= 0) {
    console.error("[Transaction Service] Invalid payment - invalid amount:", payment.amount)
    return null
  }

  try {
    const transactionId = randomUUID()
    const reference = await generateTransactionReference(payment.merchantId)

    const transaction: Transaction = {
      transactionId,
      type: "payment",
      fromId: "customer",
      fromType: "customer",
      toId: payment.merchantId,
      toType: "merchant",
      amount: payment.amount,
      currency: "π",
      paymentId: payment.id,
      description: payment.note || "Payment",
      reference,
      createdAt: new Date(),
      completedAt: new Date(),
      status: "completed",
    }

    // Store transaction
    await redis.set(`transaction:${transactionId}`, JSON.stringify(transaction))

    // Add to merchant's transaction index (sorted set by timestamp)
    const timestamp = new Date().getTime()
    await redis.zadd(`merchant:${payment.merchantId}:transactions`, {
      score: timestamp,
      member: transactionId,
    })

    // Generate receipt
    await generateReceipt(transaction, payment, piPaymentId, txid)

    // Update merchant balance
    await updateMerchantBalance(payment.merchantId, payment.amount, "unsettled")

    console.log("[Transaction Service] Transaction recorded successfully:", {
      transactionId,
      merchantId: payment.merchantId,
      amount: payment.amount,
    })

    return transaction
  } catch (error) {
    console.error("[Transaction Service] Error recording transaction:", error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Generate a receipt for a completed transaction
 * Stored separately for easy retrieval and potential PDF generation
 */
async function generateReceipt(
  transaction: Transaction,
  payment: Payment,
  piPaymentId: string,
  txid: string,
): Promise<void> {
  if (!isRedisConfigured) return

  try {
    const receipt: Receipt = {
      receiptId: randomUUID(),
      transactionId: transaction.transactionId,
      merchantId: payment.merchantId,
      merchant: {
        id: payment.merchantId,
        name: payment.merchantId, // In future, could fetch from merchant profile
      },
      payer: {
        username: "Customer",
      },
      amount: payment.amount,
      currency: "π",
      description: payment.note || "Payment",
      reference: transaction.reference,
      timestamp: new Date(),
      txid,
      piPaymentId,
    }

    await redis.set(`receipt:${transaction.transactionId}`, JSON.stringify(receipt))
  } catch (error) {
    console.error("[Transaction Service] Error generating receipt:", error)
  }
}

/**
 * Get a transaction by ID
 */
export async function getTransaction(transactionId: string): Promise<Transaction | null> {
  if (!isRedisConfigured) return null

  try {
    const data = await redis.get(`transaction:${transactionId}`)
    if (!data) return null
    return typeof data === "string" ? JSON.parse(data) : data
  } catch (error) {
    console.error("[Transaction Service] Error fetching transaction:", error)
    return null
  }
}

/**
 * Get a receipt by transaction ID
 */
export async function getReceipt(transactionId: string): Promise<Receipt | null> {
  if (!isRedisConfigured) return null

  try {
    const data = await redis.get(`receipt:${transactionId}`)
    if (!data) return null
    return typeof data === "string" ? JSON.parse(data) : data
  } catch (error) {
    console.error("[Transaction Service] Error fetching receipt:", error)
    return null
  }
}

/**
 * Get all transactions for a merchant
 * Supports pagination and filtering by date range
 */
export async function getMerchantTransactions(
  merchantId: string,
  options?: {
    limit?: number
    offset?: number
    startDate?: Date
    endDate?: Date
  },
): Promise<Transaction[]> {
  if (!isRedisConfigured) return []

  try {
    const limit = options?.limit || 50
    const offset = options?.offset || 0

    // Get transaction IDs from sorted set (most recent first)
    const transactionIds = await redis.zrevrange(`merchant:${merchantId}:transactions`, offset, offset + limit - 1)

    if (!transactionIds || transactionIds.length === 0) {
      return []
    }

    // Fetch each transaction
    const transactions: Transaction[] = []
    for (const txnId of transactionIds) {
      const txn = await getTransaction(txnId as string)
      if (txn) {
        // Filter by date range if provided
        if (options?.startDate && new Date(txn.createdAt) < options.startDate) continue
        if (options?.endDate && new Date(txn.createdAt) > options.endDate) continue
        transactions.push(txn)
      }
    }

    return transactions
  } catch (error) {
    console.error("[Transaction Service] Error fetching merchant transactions:", error)
    return []
  }
}

/**
 * Search transactions by criteria
 * Returns filtered transactions matching the query
 */
export async function searchTransactions(
  merchantId: string,
  criteria?: {
    minAmount?: number
    maxAmount?: number
    startDate?: Date
    endDate?: Date
    reference?: string
    status?: string
  },
): Promise<Transaction[]> {
  const allTransactions = await getMerchantTransactions(merchantId, {
    limit: 1000, // Fetch up to 1000 for searching
  })

  return allTransactions.filter((txn) => {
    if (criteria?.minAmount && txn.amount < criteria.minAmount) return false
    if (criteria?.maxAmount && txn.amount > criteria.maxAmount) return false
    if (criteria?.startDate && new Date(txn.createdAt) < criteria.startDate) return false
    if (criteria?.endDate && new Date(txn.createdAt) > criteria.endDate) return false
    if (criteria?.reference && !txn.reference.includes(criteria.reference)) return false
    if (criteria?.status && txn.status !== criteria.status) return false
    return true
  })
}

/**
 * Get merchant transaction summary
 */
export async function getMerchantTransactionSummary(merchantId: string): Promise<{
  totalTransactions: number
  totalAmount: number
  averageAmount: number
  latestTransactionDate?: Date
}> {
  if (!isRedisConfigured) {
    return {
      totalTransactions: 0,
      totalAmount: 0,
      averageAmount: 0,
    }
  }

  try {
    const transactions = await getMerchantTransactions(merchantId, { limit: 1000 })

    if (transactions.length === 0) {
      return {
        totalTransactions: 0,
        totalAmount: 0,
        averageAmount: 0,
      }
    }

    const totalAmount = transactions.reduce((sum, txn) => sum + txn.amount, 0)

    return {
      totalTransactions: transactions.length,
      totalAmount,
      averageAmount: totalAmount / transactions.length,
      latestTransactionDate: transactions.length > 0 ? new Date(transactions[0].createdAt) : undefined,
    }
  } catch (error) {
    console.error("[Transaction Service] Error fetching summary:", error)
    return {
      totalTransactions: 0,
      totalAmount: 0,
      averageAmount: 0,
    }
  }
}

/**
 * Update merchant balance
 * Tracks settled and unsettled amounts
 */
export async function updateMerchantBalance(
  merchantId: string,
  amount: number,
  type: "settled" | "unsettled",
): Promise<void> {
  if (!isRedisConfigured) return

  try {
    const balanceKey = `merchant:${merchantId}:balance`
    const currentBalance = await redis.get(balanceKey)

    const balance: MerchantBalance = currentBalance
      ? typeof currentBalance === "string"
        ? JSON.parse(currentBalance)
        : currentBalance
      : {
          merchantId,
          settled: 0,
          unsettled: 0,
          total: 0,
          lastUpdated: new Date(),
        }

    if (type === "settled") {
      balance.settled += amount
      balance.unsettled = Math.max(0, balance.unsettled - amount)
    } else {
      balance.unsettled += amount
    }

    balance.total = balance.settled + balance.unsettled
    balance.lastUpdated = new Date()

    await redis.set(balanceKey, JSON.stringify(balance))
  } catch (error) {
    console.error("[Transaction Service] Error updating balance:", error)
  }
}

/**
 * Get merchant balance
 */
export async function getMerchantBalance(merchantId: string): Promise<MerchantBalance> {
  if (!isRedisConfigured) {
    return {
      merchantId,
      settled: 0,
      unsettled: 0,
      total: 0,
      lastUpdated: new Date(),
    }
  }

  try {
    const data = await redis.get(`merchant:${merchantId}:balance`)
    if (!data) {
      return {
        merchantId,
        settled: 0,
        unsettled: 0,
        total: 0,
        lastUpdated: new Date(),
      }
    }
    return typeof data === "string" ? JSON.parse(data) : data
  } catch (error) {
    console.error("[Transaction Service] Error fetching balance:", error)
    return {
      merchantId,
      settled: 0,
      unsettled: 0,
      total: 0,
      lastUpdated: new Date(),
    }
  }
}
