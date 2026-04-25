/**
 * Transfer Reporting and Export Service
 * Generates reports, exports data, and provides transfer history
 */

import { query } from '@/lib/db'

export interface TransferReport {
  totalTransfers: number
  totalAmount: number
  completedAmount: number
  pendingAmount: number
  failedAmount: number
  completedCount: number
  pendingCount: number
  failedCount: number
  averageTransferTime: number
  successRate: number
  lastTransferTime?: Date
}

export interface ExportFormat {
  format: 'csv' | 'json' | 'pdf'
  includeDetails: boolean
  dateRange?: { start: Date; end: Date }
}

/**
 * Generate transfer report for a merchant
 */
export async function generateTransferReport(merchantId: string): Promise<TransferReport> {
  if (!process.env.DATABASE_URL) {
    return {
      totalTransfers: 0,
      totalAmount: 0,
      completedAmount: 0,
      pendingAmount: 0,
      failedAmount: 0,
      completedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      averageTransferTime: 0,
      successRate: 0,
    }
  }

  try {
    const result = await query(
      `SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int as completed_count,
        SUM(CASE WHEN status = 'pending' OR status = 'processing' THEN 1 ELSE 0 END)::int as pending_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int as failed_count,
        SUM(amount)::numeric as total_amount,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)::numeric as completed_amount,
        SUM(CASE WHEN status = 'pending' OR status = 'processing' THEN amount ELSE 0 END)::numeric as pending_amount,
        SUM(CASE WHEN status = 'failed' THEN amount ELSE 0 END)::numeric as failed_amount,
        AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))::int as avg_transfer_time,
        MAX(completed_at) as last_transfer_time
       FROM transfers
       WHERE merchant_id = $1`,
      [merchantId]
    )

    if (!result || result.length === 0) {
      return {
        totalTransfers: 0,
        totalAmount: 0,
        completedAmount: 0,
        pendingAmount: 0,
        failedAmount: 0,
        completedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        averageTransferTime: 0,
        successRate: 0,
      }
    }

    const row = (result as any)[0]
    const totalCount = parseInt(row.total_count) || 0
    const completedCount = parseInt(row.completed_count) || 0

    return {
      totalTransfers: totalCount,
      totalAmount: parseFloat(row.total_amount || 0),
      completedAmount: parseFloat(row.completed_amount || 0),
      pendingAmount: parseFloat(row.pending_amount || 0),
      failedAmount: parseFloat(row.failed_amount || 0),
      completedCount,
      pendingCount: parseInt(row.pending_count) || 0,
      failedCount: parseInt(row.failed_count) || 0,
      averageTransferTime: parseInt(row.avg_transfer_time) || 0,
      successRate: totalCount > 0 ? (completedCount / totalCount) * 100 : 0,
      lastTransferTime: row.last_transfer_time ? new Date(row.last_transfer_time) : undefined,
    }
  } catch (error) {
    console.error('[Report Service] generateTransferReport error:', error)
    throw error
  }
}

/**
 * Export transfers to CSV format
 */
export async function exportTransfersToCSV(merchantId: string): Promise<string> {
  if (!process.env.DATABASE_URL) return ''

  try {
    const transfers = await query(
      `SELECT
        id,
        transaction_id,
        amount,
        status,
        created_at,
        completed_at,
        pi_transfer_id,
        error_message,
        retry_count
       FROM transfers
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId]
    )

    if (!transfers || transfers.length === 0) {
      return 'Transfer ID,Transaction ID,Amount (Pi),Status,Created At,Completed At,Pi Transfer ID,Error,Retry Count\n'
    }

    const headers = ['Transfer ID', 'Transaction ID', 'Amount (Pi)', 'Status', 'Created At', 'Completed At', 'Pi Transfer ID', 'Error', 'Retry Count']
    const rows = (transfers as any[]).map(t => [
      t.id,
      t.transaction_id,
      t.amount,
      t.status,
      new Date(t.created_at).toISOString(),
      t.completed_at ? new Date(t.completed_at).toISOString() : '',
      t.pi_transfer_id || '',
      t.error_message || '',
      t.retry_count,
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map(row =>
        row
          .map(cell => {
            const str = String(cell)
            return str.includes(',') ? `"${str.replace(/"/g, '""')}"` : str
          })
          .join(',')
      ),
    ].join('\n')

    return csvContent
  } catch (error) {
    console.error('[Report Service] exportTransfersToCSV error:', error)
    throw error
  }
}

/**
 * Export transfers to JSON format
 */
export async function exportTransfersToJSON(merchantId: string): Promise<any> {
  if (!process.env.DATABASE_URL) return { transfers: [], report: {} }

  try {
    const transfers = await query(
      `SELECT *
       FROM transfers
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId]
    )

    const report = await generateTransferReport(merchantId)

    return {
      report,
      transfers: transfers || [],
      exportDate: new Date().toISOString(),
      merchantId,
    }
  } catch (error) {
    console.error('[Report Service] exportTransfersToJSON error:', error)
    throw error
  }
}

/**
 * Get transfer history with pagination
 */
export async function getTransferHistory(
  merchantId: string,
  page: number = 1,
  pageSize: number = 25
) {
  if (!process.env.DATABASE_URL) return { transfers: [], total: 0, page, pageSize }

  try {
    const offset = (page - 1) * pageSize

    const [transfersResult, countResult] = await Promise.all([
      query(
        `SELECT *
         FROM transfers
         WHERE merchant_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [merchantId, pageSize, offset]
      ),
      query(
        `SELECT COUNT(*) as count FROM transfers WHERE merchant_id = $1`,
        [merchantId]
      ),
    ])

    const total = countResult && countResult.length > 0 ? parseInt((countResult[0] as any).count) : 0

    return {
      transfers: transfersResult || [],
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    }
  } catch (error) {
    console.error('[Report Service] getTransferHistory error:', error)
    throw error
  }
}

/**
 * Get transfer details
 */
export async function getTransferDetails(transferId: string) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `SELECT t.*, tr.payment_id, tr.amount as transaction_amount, tr.status as transaction_status
       FROM transfers t
       LEFT JOIN transactions tr ON t.transaction_id = tr.id
       WHERE t.id = $1`,
      [transferId]
    )

    return result && result.length > 0 ? (result[0] as any) : null
  } catch (error) {
    console.error('[Report Service] getTransferDetails error:', error)
    throw error
  }
}

/**
 * Generate statement for date range
 */
export async function generateStatement(
  merchantId: string,
  startDate: Date,
  endDate: Date
) {
  if (!process.env.DATABASE_URL) return null

  try {
    const result = await query(
      `SELECT
        COUNT(*) as transfer_count,
        SUM(amount)::numeric as total_amount,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END)::numeric as completed_amount,
        MIN(created_at) as period_start,
        MAX(created_at) as period_end
       FROM transfers
       WHERE merchant_id = $1
       AND created_at >= $2
       AND created_at < $3`,
      [merchantId, startDate, endDate]
    )

    if (!result || result.length === 0) return null

    const row = (result[0] as any)

    return {
      merchantId,
      period: { start: startDate, end: endDate },
      transferCount: parseInt(row.transfer_count) || 0,
      totalAmount: parseFloat(row.total_amount || 0),
      completedAmount: parseFloat(row.completed_amount || 0),
      generatedAt: new Date(),
    }
  } catch (error) {
    console.error('[Report Service] generateStatement error:', error)
    throw error
  }
}
