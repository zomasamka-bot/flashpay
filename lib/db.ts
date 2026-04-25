'use server'

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

    // Create receipts table
    await query(`
      CREATE TABLE IF NOT EXISTS receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        timestamp TIMESTAMP NOT NULL,
        txid TEXT,
        payer_username TEXT,
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

    // Create transfers table for tracking fund transfers from app wallet to merchant wallet
    await query(`
      CREATE TABLE IF NOT EXISTS transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_address TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pi_transfer_id TEXT UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)

    // Create indexes for transfers
    await query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_merchant_status
      ON transfers(merchant_id, status)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_status
      ON transfers(status)
    `)

    await query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_created
      ON transfers(created_at DESC)
    `)

    

    console.log('[DB] Schema initialization complete')
  } catch (error) {
    console.error('[DB] Schema initialization error:', error)
    throw error
  }
}

/**
 * Get a transaction by ID
 */
export async function getTransaction(transactionId: string) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM transactions WHERE id = $1',
      [transactionId]
    )
    return result && result.length > 0 ? (result as any)[0] : null
  } catch (error) {
    console.error('[DB] getTransaction failed:', error)
    return null
  }
}

/**
 * Get receipt by transaction ID
 */
export async function getReceipt(transactionId: string) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM receipts WHERE transaction_id = $1',
      [transactionId]
    )
    return result && result.length > 0 ? (result as any)[0] : null
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
    const total = countResult && countResult.length > 0 ? parseInt((countResult[0] as any).count, 10) : 0

    // Get paginated results using parameterized LIMIT and OFFSET
    const limitParam = paramIndex
    const offsetParam = paramIndex + 1
    const transactionsQuery = `
      SELECT * FROM transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `
    const queryParams = [...params, limit, offset]
    const transactionsResult = await query(transactionsQuery, queryParams)

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
export async function getMerchantBalance(merchantId: string) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM merchant_balances WHERE merchant_id = $1',
      [merchantId]
    )
    return result && result.length > 0 ? (result as any)[0] : null
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
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO merchant_balances (merchant_id, settled, unsettled, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (merchant_id) DO UPDATE
       SET settled = $2, unsettled = $3, last_updated = NOW()
       RETURNING *`,
      [merchantId, settled, unsettled]
    )
    return result && result.length > 0 ? (result as any)[0] : null
  } catch (error) {
    console.error('[DB] updateMerchantBalance failed:', error)
    return null
  }
}

/**
 * Record a new transfer request
 */
export async function createTransferRequest(
  transactionId: string,
  merchantId: string,
  merchantAddress: string,
  amount: number
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `INSERT INTO transfers
       (transaction_id, merchant_id, merchant_address, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())
       RETURNING *`,
      [transactionId, merchantId, merchantAddress, amount]
    )

    console.log('[DB] Transfer request created', { transactionId, merchantId, amount })
    return result && result.length > 0 ? (result as any)[0] : null
  } catch (error) {
    console.error('[DB] createTransferRequest failed:', error)
    return null
  }
}

/**
 * Get pending transfers (for retry processing)
 */
export async function getPendingTransfers(limit: number = 10) {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT * FROM transfers
       WHERE status IN ('pending', 'failed')
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    )
    return result || []
  } catch (error) {
    console.error('[DB] getPendingTransfers failed:', error)
    return []
  }
}

/**
 * Get transfers for a merchant
 */
export async function getTransfersByMerchant(merchantId: string, limit: number = 50) {
  if (!process.env.DATABASE_URL) return []

  try {
    const result = await query(
      `SELECT * FROM transfers
       WHERE merchant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [merchantId, limit]
    )
    return result || []
  } catch (error) {
    console.error('[DB] getTransfersByMerchant failed:', error)
    return []
  }
}

/**
 * Update transfer status
 */
export async function updateTransferStatus(
  transferId: string,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  piTransferId?: string,
  errorMessage?: string
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const updates: string[] = ['status = $2', 'last_retry_at = NOW()']
    const params: any[] = [transferId, status]
    let paramIndex = 3

    if (status === 'completed') {
      updates.push(`completed_at = NOW()`)
      if (piTransferId) {
        updates.push(`pi_transfer_id = $${paramIndex}`)
        params.push(piTransferId)
        paramIndex++
      }
    }

    if (status === 'failed' && errorMessage) {
      updates.push(`error_message = $${paramIndex}`)
      params.push(errorMessage)
      paramIndex++
    }

    updates.push(`retry_count = retry_count + 1`)

    const result = await query(
      `UPDATE transfers 
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      params
    )

    console.log('[DB] Transfer status updated:', { transferId, status, piTransferId })
    return result && result.length > 0 ? (result as any)[0] : null
  } catch (error) {
    console.error('[DB] updateTransferStatus failed:', error)
    return null
  }
}

/**
 * Get transfer by ID
 */
export async function getTransfer(transferId: string) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      'SELECT * FROM transfers WHERE id = $1',
      [transferId]
    )
    return result && result.length > 0 ? (result as any)[0] : null
  } catch (error) {
    console.error('[DB] getTransfer failed:', error)
    return null
  }
}

/**
 * Get total transferred amount for a merchant
 */
export async function getMerchantTransferredAmount(merchantId: string) {
  if (!process.env.DATABASE_URL) return 0

  try {
    const result = await query(
      `SELECT SUM(amount)::numeric as total FROM transfers 
       WHERE merchant_id = $1 AND status = 'completed'`,
      [merchantId]
    )
    return result && result.length > 0 ? parseFloat((result[0] as any).total || 0) : 0
  } catch (error) {
    console.error('[DB] getMerchantTransferredAmount failed:', error)
    return 0
  }
}

/**
 * Get unread notifications for a merchant
 */
export async function getUnreadNotifications(merchantId: string): Promise<any[]> {
  if (!process.env.DATABASE_URL) return []

  try {
    const client = await getPostgresClient()
    if (!client) return []

    const result = await client`
      SELECT 
        id, transfer_id as "transferId", merchant_id as "merchantId",
        notification_type as type, title, message, status,
        created_at as "createdAt", read_at as "readAt"
      FROM transfer_notifications
      WHERE merchant_id = ${merchantId} AND status = 'unread'
      ORDER BY created_at DESC
      LIMIT 50
    `

    return result || []
  } catch (error) {
    console.error('[DB] getUnreadNotifications failed:', error)
    return []
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationAsRead(notificationId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false

  try {
    const client = await getPostgresClient()
    if (!client) return false

    await client`
      UPDATE transfer_notifications
      SET status = 'read', read_at = NOW()
      WHERE id = ${notificationId}
    `

    return true
  } catch (error) {
    console.error('[DB] markNotificationAsRead failed:', error)
    return false
  }
}

/**
 * Record a settlement transfer to merchant (backward compatibility)
 */
export async function recordSettlementTransfer(
  merchantId: string,
  transactionId: string,
  amount: number,
  txid?: string
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const client = await getPostgresClient()
    if (!client) return null

    const result = await client`
      INSERT INTO settlement_requests
       (merchant_id, transaction_id, amount, status, created_at)
       VALUES (${merchantId}, ${transactionId}, ${amount}, 'queued', NOW())
       RETURNING *
    `

    console.log('[DB] Settlement request queued', { merchantId, amount })
    return result && result.length > 0 ? result[0] : null
  } catch (error) {
    console.error('[DB] Settlement request failed:', error)
    return null
  }
}

/**
 * Get pending settlements for a merchant
 */
export async function getPendingSettlements(merchantId: string) {
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
    return result || []
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
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const updates: string[] = ['status = $2', 'retry_count = retry_count + 1']
    const params: any[] = [settlementId, status]
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
    return result && result.length > 0 ? (result as any)[0] : null
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
