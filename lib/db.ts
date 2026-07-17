'use server'

import { randomUUID } from 'crypto'
import type { SettlementRequest, TransactionRow, ReceiptRow, MerchantBalanceRow } from './types'

// Database layer - handles PostgreSQL/Neon integration via postgres client
// Note: Functions that use database client are server-only

// Singleton connection instance
let sqlClient: any = null
let initializationAttempted = false

// Get or create the postgres client connection
async function getPostgresClient() {
  // Return cached client if already initialized
  if (sqlClient !== null) {
    return sqlClient
  }

  // Return null if already tried and failed
  if (initializationAttempted) {
    return null
  }

  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not configured, cannot initialize postgres client')
    initializationAttempted = true
    return null
  }

  try {
    console.log('[DB] Initializing postgres client...')
    // Import the postgres client
    const postgres = await import('postgres')
    const sql = postgres.default

    if (!sql) {
      console.error('[DB] Postgres client is not available from the module')
      initializationAttempted = true
      return null
    }

    // Create client instance with connection URL
    sqlClient = sql(process.env.DATABASE_URL)
    initializationAttempted = true
    console.log('[DB] Postgres client initialized successfully')
    return sqlClient
  } catch (error) {
    console.error('[DB] Failed to load postgres client:', error)
    initializationAttempted = true
    sqlClient = null
    return null
  }
}

/**
 * Execute a raw SQL query using postgres client (server-side only)
 */
export async function query(text: string, values?: unknown[]) {
  // Check if PostgreSQL is configured
  if (!process.env.DATABASE_URL) {
    console.warn('[DB] PostgreSQL not configured, query blocked')
    return null
  }

  try {
    const client = await getPostgresClient()
    if (!client) {
      console.error('[DB] Postgres client failed to initialize')
      return null
    }

    console.log('[DB] Executing query:', text.substring(0, 60) + '...')

    // Use parameterized query with postgres client
    let result: any

    if (values && values.length > 0) {
      // Postgres client handles parameterization automatically
      result = await client.unsafe(text, values)
    } else {
      result = await client.unsafe(text)
    }

    console.log('[DB] Query succeeded, rows:', result?.length || 0)
    return result as unknown[]
  } catch (error) {
    console.error('[DB] Query execution failed:', error)
    return null
  }
}

/**
 * Initialize database schema on first run
 */
export async function initializeSchema() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] PostgreSQL not configured, skipping schema initialization')
    return
  }

  try {
    console.log('[DB] Creating database schema...')

    // Create transactions table
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id TEXT NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        reference TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `)

    // Create indexes for transactions
    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created
      ON transactions(merchant_id, created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_created
      ON transactions(created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_payment_id
      ON transactions(payment_id)
    `)

    // Create receipts table with U2A and A2U identifiers
    await query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        timestamp TIMESTAMP NOT NULL,
        txid TEXT,
        payer_username TEXT,
        u2a_identifier TEXT,
        u2a_txid TEXT,
        a2u_identifier TEXT,
        a2u_txid TEXT,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)

    // Create indexes for receipts
    await query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_merchant
      ON receipts(merchant_id, created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_receipts_created
      ON receipts(created_at DESC)
    `)

    // Safely add merchant_uid column to transactions if it doesn't exist
    try {
      await query(`
        ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT ''
      `)
      console.log('[DB] merchant_uid column added to transactions (if needed)')
    } catch (e) {
      // Column may already exist or table may not exist yet, continue
      console.log('[DB] merchant_uid column migration for transactions (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add merchant_uid column to receipts if it doesn't exist
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT ''
      `)
      console.log('[DB] merchant_uid column added to receipts (if needed)')
    } catch (e) {
      // Column may already exist or table may not exist yet, continue
      console.log('[DB] merchant_uid column migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add U2A identifier columns to receipts
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_identifier TEXT
      `)
      console.log('[DB] u2a_identifier column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] u2a_identifier migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_txid TEXT
      `)
      console.log('[DB] u2a_txid column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] u2a_txid migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Safely add A2U identifier columns to receipts
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_identifier TEXT
      `)
      console.log('[DB] a2u_identifier column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] a2u_identifier migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_txid TEXT
      `)
      console.log('[DB] a2u_txid column added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] a2u_txid migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Add fee and accounting tracking columns to receipts
    try {
      await query(`
        ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS customer_amount NUMERIC(18, 8),
        ADD COLUMN IF NOT EXISTS horizon_fee_charged NUMERIC(18, 8) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS app_commission NUMERIC(18, 8) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS merchant_amount NUMERIC(18, 8),
        ADD COLUMN IF NOT EXISTS app_net_impact NUMERIC(18, 8) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending'
      `)
      console.log('[DB] Fee tracking columns added to receipts (if needed)')
    } catch (e) {
      console.log('[DB] Fee tracking migration for receipts (non-blocking):', (e as any).message?.substring(0, 100))
    }

    // Create merchant balances table
    await query(`
      CREATE TABLE IF NOT EXISTS merchant_balances (
        merchant_id TEXT PRIMARY KEY,
        settled NUMERIC(18, 8) DEFAULT 0,
        unsettled NUMERIC(18, 8) DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      )
    `)

    // Create index for merchant balances
    await query(`
      CREATE INDEX IF NOT EXISTS idx_merchant_balances_merchant
      ON merchant_balances(merchant_id)
    `)

    // Create settlement_requests table for tracking merchant payouts
    await query(`
      CREATE TABLE IF NOT EXISTS settlement_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id TEXT NOT NULL,
        transaction_id UUID NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        txid TEXT,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)

    // Create indexes for settlement requests
    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_merchant_status
      ON settlement_requests(merchant_id, status)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_created
      ON settlement_requests(created_at DESC)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_settlement_requests_status
      ON settlement_requests(status)
    `)

    console.log('[DB] Schema initialization complete')
  } catch (error) {
    console.error('[DB] Schema initialization error:', error)
    throw error
  }
}

/**
 * Get transaction by ID
 */
export async function getTransaction(transactionId: string): Promise<TransactionRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM transactions WHERE id = $1',
      [transactionId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as TransactionRow
  } catch (error) {
    console.error('[DB] getTransaction failed:', error)
    return null
  }
}

/**
 * Get receipt by transaction ID (includes transaction reference and description)
 */
export async function getReceipt(transactionId: string): Promise<ReceiptRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `SELECT 
        r.*,
        t.reference,
        t.description,
        t.merchant_id
      FROM receipts r
      LEFT JOIN transactions t ON r.transaction_id = t.id
      WHERE r.transaction_id = $1`,
      [transactionId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as ReceiptRow
  } catch (error) {
    console.error('[DB] getReceipt failed:', error)
    return null
  }
}

/**
 * Get transactions by merchant with date range
 */
export async function getTransactionsByMerchant(
  merchantId: string,
  options: {
    fromDate?: Date
    toDate?: Date
    limit?: number
    offset?: number
  } = {}
) {
  if (!process.env.DATABASE_URL) return { transactions: [], total: 0 }

  try {
    const limit = options.limit || 50
    const offset = options.offset || 0

    // Build WHERE clause with date filters
    let whereClause = 'WHERE merchant_id = $1'
    const params: any[] = [merchantId]
    let paramIndex = 2

    if (options.fromDate) {
      whereClause += ` AND created_at >= $${paramIndex}`
      params.push(options.fromDate)
      paramIndex++
    }

    if (options.toDate) {
      whereClause += ` AND created_at <= $${paramIndex}`
      params.push(options.toDate)
      paramIndex++
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM transactions ${whereClause}`
    const countResult = await query(countQuery, params)
    
    // Validate and convert count
    let total = 0
    if (Array.isArray(countResult) && countResult.length > 0) {
      const row = countResult[0] as unknown
      if (typeof row === 'object' && row !== null) {
        const rowObj = row as Record<string, unknown>
        const countNum = Number(rowObj.count)
        if (Number.isFinite(countNum) && countNum >= 0) {
          total = countNum
        }
      }
    }

    // Get paginated results
    const transactionsQuery = `
      SELECT * FROM transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
    const transactionsResult = await query(transactionsQuery, params)

    return {
      transactions: transactionsResult || [],
      total,
    }
  } catch (error) {
    console.error('[DB] getTransactionsByMerchant failed:', error)
    return { transactions: [], total: 0 }
  }
}

/**
 * Get merchant balance
 */
export async function getMerchantBalance(merchantId: string): Promise<MerchantBalanceRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM merchant_balances WHERE merchant_id = $1',
      [merchantId]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as MerchantBalanceRow
  } catch (error) {
    console.error('[DB] getMerchantBalance failed:', error)
    return null
  }
}

/**
 * Update merchant balance
 */
export async function updateMerchantBalance(
  merchantId: string,
  settled: number,
  unsettled: number
): Promise<MerchantBalanceRow | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO merchant_balances (merchant_id, settled, unsettled, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (merchant_id) DO UPDATE
       SET settled = merchant_balances.settled + EXCLUDED.settled,
           unsettled = merchant_balances.unsettled + EXCLUDED.unsettled,
           last_updated = NOW()
       RETURNING *`,
      [merchantId, settled, unsettled]
    )
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as MerchantBalanceRow
  } catch (error) {
    console.error('[DB] updateMerchantBalance failed:', error)
    return null
  }
}

/**
 * Record a settlement transfer to merchant
 */
export async function recordSettlementTransfer(
  merchantId: string,
  transactionId: string,
  amount: number,
  txid?: string
): Promise<SettlementRequest | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO settlement_requests
       (merchant_id, transaction_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'queued', NOW())
       RETURNING *`,
      [merchantId, transactionId, amount]
    )

    console.log('[DB] Settlement request queued', { merchantId, amount })
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as SettlementRequest
  } catch (error) {
    console.error('[DB] Settlement request failed:', error)
    return null
  }
}

/**
 * Get pending settlements for a merchant
 * Validates and normalizes each row to SettlementRequest type
 */
export async function getPendingSettlements(merchantId: string): Promise<SettlementRequest[]> {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT sr.*, t.payment_id 
       FROM settlement_requests sr
       LEFT JOIN transactions t ON sr.transaction_id = t.id
       WHERE sr.merchant_id = $1 AND sr.status IN ('queued', 'processing')
       ORDER BY sr.created_at ASC`,
      [merchantId]
    )

    if (!result || result.length === 0) return []

    // Validate and normalize each row
    const validated: SettlementRequest[] = []
    for (const row of result) {
      const unknown = row as unknown
      
      // Validate required string fields
      if (typeof unknown !== 'object' || unknown === null) continue
      const obj = unknown as Record<string, unknown>
      
      if (typeof obj.id !== 'string') continue
      if (typeof obj.merchant_id !== 'string') continue
      if (typeof obj.transaction_id !== 'string') continue
      if (typeof obj.status !== 'string') continue
      if (typeof obj.created_at !== 'string') continue
      
      // Validate allowed status union
      const status = obj.status as string
      if (!['queued', 'processing', 'completed', 'failed'].includes(status)) continue
      
      // Convert amount with validation
      const amountNum = Number(obj.amount)
      if (!Number.isFinite(amountNum)) continue
      
      // Convert retry_count with validation
      const retryNum = Number(obj.retry_count ?? 0)
      if (!Number.isFinite(retryNum)) continue
      
      validated.push({
        id: obj.id,
        merchant_id: obj.merchant_id,
        transaction_id: obj.transaction_id,
        amount: amountNum,
        status: status as 'queued' | 'processing' | 'completed' | 'failed',
        created_at: obj.created_at,
        completed_at: typeof obj.completed_at === 'string' ? obj.completed_at : undefined,
        txid: typeof obj.txid === 'string' ? obj.txid : undefined,
        error_message: typeof obj.error_message === 'string' ? obj.error_message : undefined,
        retry_count: retryNum,
        payment_id: typeof obj.payment_id === 'string' ? obj.payment_id : undefined,
      })
    }

    return validated
  } catch (error) {
    console.error('[DB] getPendingSettlements failed:', error)
    return []
  }
}

/**
 * Update settlement status and txid
 */
export async function updateSettlementStatus(
  settlementId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  txid?: string,
  errorMessage?: string
): Promise<SettlementRequest | null> {
  if (!process.env.DATABASE_URL) return null

  try {
    const updates: string[] = ['status = $2', 'retry_count = retry_count + 1']
    const params: unknown[] = [settlementId, status]
    let paramIndex = 3

    if (status === 'completed') {
      updates.push(`completed_at = NOW()`)
      if (txid) {
        updates.push(`txid = $${paramIndex}`)
        params.push(txid)
        paramIndex++
      }
    }

    if (status === 'failed' && errorMessage) {
      updates.push(`error_message = $${paramIndex}`)
      params.push(errorMessage)
      paramIndex++
    }

    const result = await query(
      `UPDATE settlement_requests 
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      params
    )

    console.log('[DB] Settlement status updated:', { settlementId, status, txid })
    if (!Array.isArray(result) || result.length === 0) return null
    const row = result[0]
    if (typeof row !== 'object' || row === null) return null
    return row as SettlementRequest
  } catch (error) {
    console.error('[DB] updateSettlementStatus failed:', error)
    return null
  }
}

/**
 * Get settlement history for merchant
 */
export async function getSettlementHistory(merchantId: string, limit: number = 50) {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT sr.*, t.payment_id, t.created_at as payment_date
       FROM settlement_requests sr
       LEFT JOIN transactions t ON sr.transaction_id = t.id
       WHERE sr.merchant_id = $1
       ORDER BY sr.created_at DESC
       LIMIT $2`,
      [merchantId, limit]
    )
    return result || []
  } catch (error) {
    console.error('[DB] getSettlementHistory failed:', error)
    return []
  }
}

/**
 * Record A2U transaction atomically after funds reach merchant wallet
 * Inserts transaction, receipt, updates merchant balance, and stores payment IDs/txids
 * Uses transaction-scoped client for true ACID guarantees - all or nothing
 */
export async function recordA2UTransactionAtomic(params: {
  u2aIdentifier: string      // U2A identifier from Pi webhook (identifier field)
  u2aTxid: string            // clientTxid from U2A flow
  a2uIdentifier: string      // A2U identifier from A2U response
  a2uTxid: string            // Horizon transaction ID from A2U flow
  merchantId: string
  merchantUid: string
  amount: number             // Customer amount (amount paid in U2A)
  horizonFeeCharged?: number // Horizon fee in Pi (stroops / 1e7)
  appCommission?: number     // App commission (default 0)
  note?: string
  createdAt?: Date
}): Promise<{ success: boolean; error?: string; transactionId?: string }> {
  // Calculate merchant amount (what merchant receives after fees)
  const horizonFee = params.horizonFeeCharged || 0
  const appCommission = params.appCommission || 0
  const merchantAmount = params.amount - horizonFee - appCommission
  const appNetImpact = horizonFee + appCommission
  if (!process.env.DATABASE_URL) {
    console.error('[DB] PostgreSQL not configured for A2U transaction')
    return { success: false, error: 'Database not configured' }
  }

  try {
    console.log('[DB] Starting atomic A2U transaction:', {
      u2aIdentifier: params.u2aIdentifier,
      a2uIdentifier: params.a2uIdentifier,
      a2uTxid: params.a2uTxid,
      merchantId: params.merchantId,
      amount: params.amount,
    })

    const transactionId = randomUUID()
    const reference = `PAY-${new Date().getFullYear()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`
    const createdAtDate = params.createdAt || new Date()

    // Import postgres and create actual client from DATABASE_URL
    const postgres = await import('postgres')
    const sql = postgres.default
    if (!sql || !process.env.DATABASE_URL) {
      return { success: false, error: 'PostgreSQL client unavailable' }
    }

    const client = sql(process.env.DATABASE_URL)
    
    try {
      // Use postgres transaction callback API (no manual BEGIN/COMMIT/ROLLBACK)
      const result = await client.begin(async (tx) => {
        // 1. Upsert transaction with RETURNING id to get actual ID (new or existing)
        const txResult = await tx`
          INSERT INTO transactions (
            id, payment_id, merchant_id, merchant_uid, amount, currency, 
            reference, description, status, created_at, completed_at
          ) VALUES (${transactionId}, ${params.u2aIdentifier}, ${params.merchantId}, ${params.merchantUid}, 
                    ${params.amount}, ${'π'}, ${reference}, ${params.note || 'A2U Settlement'}, 
                    ${'completed'}, ${createdAtDate.toISOString()}, NOW())
          ON CONFLICT (payment_id) DO UPDATE SET completed_at = NOW()
          RETURNING id
        `
        
        // Get the actual transaction ID (new or existing)
        const actualTransactionId = txResult[0]?.id || transactionId
        
        // 2. Insert receipt idempotently with fee tracking using the actual transaction ID
        const receiptResult = await tx`
          INSERT INTO receipts (
            transaction_id, merchant_id, merchant_uid, amount, currency, timestamp, txid,
            u2a_identifier, u2a_txid, a2u_identifier, a2u_txid, metadata, created_at,
            customer_amount, horizon_fee_charged, app_commission, merchant_amount, app_net_impact, settlement_status
          ) VALUES (${actualTransactionId}, ${params.merchantId}, ${params.merchantUid}, ${params.amount},
                    ${'π'}, NOW(), ${params.a2uTxid}, ${params.u2aIdentifier}, ${params.u2aTxid},
                    ${params.a2uIdentifier}, ${params.a2uTxid},
                    ${JSON.stringify({ u2aIdentifier: params.u2aIdentifier, u2aTxid: params.u2aTxid, a2uIdentifier: params.a2uIdentifier, a2uTxid: params.a2uTxid })},
                    NOW(),
                    ${params.amount}, ${horizonFee}, ${appCommission}, ${merchantAmount}, ${appNetImpact}, ${'completed'})
          ON CONFLICT (transaction_id) DO NOTHING
          RETURNING id
        `

        // Only increment settled if receipt was newly inserted (RETURNING returned a row)
        const receiptWasInserted = receiptResult && receiptResult.length > 0

        // 3. Update merchant balance - only increment if receipt is new
        if (receiptWasInserted) {
          await tx`
            INSERT INTO merchant_balances (merchant_id, settled, unsettled, last_updated)
            VALUES (${params.merchantId}, ${params.amount}, 0, NOW())
            ON CONFLICT (merchant_id) DO UPDATE
            SET settled = merchant_balances.settled + EXCLUDED.settled,
                last_updated = NOW()
          `
        }
        
        return actualTransactionId
      })
      
      console.log('[DB] A2U transaction committed successfully:', { transactionId: result })
      return { success: true, transactionId: result }
    } finally {
      await client.end()
    }
  } catch (error) {
    console.error('[DB] A2U atomic transaction failed:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
