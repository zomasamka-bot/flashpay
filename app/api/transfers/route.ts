/**
 * GET /api/transfers - Fetch transfer history for merchant
 * POST /api/transfers/retry - Manually retry a failed transfer
 * GET /api/transfers/export - Export transfer history as CSV
 */

import { NextRequest, NextResponse } from 'next/server'
import { getTransfersByMerchant, getMerchantTransferredAmount, getTransfer } from '@/lib/db'
import { retryTransfer } from '@/lib/transfer-service'

/**
 * GET /api/transfers?merchantId=X&limit=50&offset=0
 * Fetch transfer history with statistics
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get('merchantId')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 1000)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    if (!merchantId) {
      return NextResponse.json({ error: 'merchantId required' }, { status: 400 })
    }

    console.log('[Transfer API] Fetching history for merchant:', merchantId)

    // Get transfer history
    const transfers = await getTransfersByMerchant(merchantId, limit + offset)
    const paginatedTransfers = transfers.slice(offset, offset + limit)

    // Get total transferred amount
    const totalTransferred = await getMerchantTransferredAmount(merchantId)

    // Calculate statistics
    const stats = {
      total: transfers.length,
      completed: transfers.filter((t: any) => t.status === 'completed').length,
      pending: transfers.filter((t: any) => t.status === 'pending').length,
      processing: transfers.filter((t: any) => t.status === 'processing').length,
      failed: transfers.filter((t: any) => t.status === 'failed').length,
      totalAmount: totalTransferred,
    }

    return NextResponse.json({
      transfers: paginatedTransfers,
      stats,
      pagination: {
        limit,
        offset,
        total: transfers.length,
      },
      merchantId,
    })
  } catch (error) {
    console.error('[Transfer API] GET failed:', error)
    return NextResponse.json({ error: 'Failed to fetch transfers' }, { status: 500 })
  }
}

/**
 * POST /api/transfers/retry
 * Manually retry a failed transfer
 */
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action === 'retry') {
      const body = await request.json().catch(() => ({}))
      const { transferId } = body

      if (!transferId) {
        return NextResponse.json({ error: 'transferId required' }, { status: 400 })
      }

      console.log('[Transfer API] Retrying transfer:', transferId)

      const transfer = await getTransfer(transferId)
      if (!transfer) {
        return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
      }

      // Only allow retry for pending or failed transfers
      if (!['pending', 'failed'].includes(transfer.status)) {
        return NextResponse.json(
          { error: `Cannot retry transfer with status: ${transfer.status}` },
          { status: 400 }
        )
      }

      const result = await retryTransfer(transferId)

      if (!result.success) {
        return NextResponse.json(
          { error: result.error || 'Retry failed' },
          { status: 500 }
        )
      }

      return NextResponse.json({
        message: 'Transfer retry initiated',
        transferId,
        status: 'processing',
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('[Transfer API] POST failed:', error)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }
}

/**
 * PUT /api/transfers/export?merchantId=X&format=csv
 * Export transfer history as CSV or JSON
 */
export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get('merchantId')
    const format = searchParams.get('format') || 'csv'

    if (!merchantId) {
      return NextResponse.json({ error: 'merchantId required' }, { status: 400 })
    }

    console.log('[Transfer API] Exporting transfers:', { merchantId, format })

    const transfers = await getTransfersByMerchant(merchantId, 10000)
    const totalAmount = await getMerchantTransferredAmount(merchantId)

    if (format === 'json') {
      return NextResponse.json(
        {
          merchantId,
          exportDate: new Date().toISOString(),
          totalTransfers: transfers.length,
          totalAmount,
          transfers,
        },
        {
          headers: {
            'Content-Disposition': `attachment; filename="transfers-${merchantId}-${Date.now()}.json"`,
          },
        }
      )
    }

    // CSV Format
    const csvHeader = [
      'Transfer ID',
      'Status',
      'Amount (Pi)',
      'Merchant Address',
      'Pi Transfer ID',
      'Created At',
      'Completed At',
      'Error Message',
      'Retry Count',
    ].join(',')

    const csvRows = transfers
      .map(
        (t: any) =>
          [
            t.id,
            t.status,
            t.amount,
            t.merchant_address,
            t.pi_transfer_id || '',
            t.created_at,
            t.completed_at || '',
            (t.error_message || '').replace(/"/g, '""'),
            t.retry_count,
          ]
            .map((v) => `"${v}"`)
            .join(',')
      )
      .join('\n')

    const csvSummary = [
      '',
      'SUMMARY',
      `Total Transfers: ${transfers.length}`,
      `Total Amount Transferred: ${totalAmount} Pi`,
      `Completed: ${transfers.filter((t: any) => t.status === 'completed').length}`,
      `Pending: ${transfers.filter((t: any) => t.status === 'pending').length}`,
      `Failed: ${transfers.filter((t: any) => t.status === 'failed').length}`,
      `Export Date: ${new Date().toISOString()}`,
    ].join('\n')

    const csv = [csvHeader, csvRows, csvSummary].join('\n')

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': `attachment; filename="transfers-${merchantId}-${Date.now()}.csv"`,
      },
    })
  } catch (error) {
    console.error('[Transfer API] Export failed:', error)
    return NextResponse.json({ error: 'Export failed' }, { status: 500 })
  }
}
