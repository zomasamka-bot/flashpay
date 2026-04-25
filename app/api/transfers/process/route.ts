import { NextRequest, NextResponse } from 'next/server'
import { recordTransactionToPG } from '@/lib/transaction-pg-service'
import { createTransferRequest } from '@/lib/db'
import { executeTransfer } from '@/lib/transfer-service'
import { unifiedStore } from '@/lib/unified-store'

/**
 * POST /api/transfers/process
 * Initiate a transfer from app wallet to merchant wallet after payment completion
 * Called after payment is marked as PAID
 * Non-blocking: Returns immediately while transfer executes in background
 */
export async function POST(request: NextRequest) {
  const startMs = Date.now()

  try {
    const {
      transactionId,
      merchantId,
      merchantAddress,
      amount,
    }: {
      transactionId: string
      merchantId: string
      merchantAddress: string
      amount: number
    } = await request.json()

    // Validate input
    if (!transactionId || !merchantId || !merchantAddress || !amount) {
      console.error('[Transfers API] Missing required fields', {
        transactionId,
        merchantId,
        merchantAddress,
        amount,
      })
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    console.log('[Transfers API] Processing transfer request', {
      merchantId,
      amount,
      merchantAddress,
    })

    // Create transfer record in database
    const transferRecord = await createTransferRequest(
      transactionId,
      merchantId,
      merchantAddress,
      amount
    )

    if (!transferRecord) {
      console.error('[Transfers API] Failed to create transfer record')
      return NextResponse.json({ error: 'Failed to record transfer' }, { status: 500 })
    }

    const transferId = transferRecord.id

    console.log('[Transfers API] Transfer record created, transferId:', transferId)

    // Start transfer in background (non-blocking)
    // Return immediately to avoid blocking payment completion flow
    executeTransferAsync(transferId, merchantAddress, amount).catch((err) => {
      console.error('[Transfers API] Background transfer failed:', err)
    })

    console.log('[Transfers API] Initiated in', Date.now() - startMs, 'ms')

    return NextResponse.json(
      {
        success: true,
        transferId,
        message: 'Transfer initiated and queued for processing',
      },
      { status: 202 } // 202 Accepted - async operation
    )
  } catch (error) {
    console.error('[Transfers API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * GET /api/transfers/process?merchantId=XXX
 * Get transfer history and status for a merchant
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const merchantId = searchParams.get('merchantId')
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500)

    if (!merchantId) {
      return NextResponse.json({ error: 'merchantId required' }, { status: 400 })
    }

    const { getTransfersByMerchant } = await import('@/lib/db')
    const transfers = await getTransfersByMerchant(merchantId, limit)

    // Calculate comprehensive stats
    const completedTransfers = transfers.filter((t: any) => t.status === 'completed')
    const pendingTransfers = transfers.filter((t: any) => t.status === 'pending')
    const processingTransfers = transfers.filter((t: any) => t.status === 'processing')
    const failedTransfers = transfers.filter((t: any) => t.status === 'failed')

    const stats = {
      total: transfers.length,
      pending: pendingTransfers.length,
      processing: processingTransfers.length,
      completed: completedTransfers.length,
      failed: failedTransfers.length,
      totalAmount: transfers.reduce((sum: number, t: any) => sum + parseFloat(t.amount || 0), 0),
      completedAmount: completedTransfers.reduce(
        (sum: number, t: any) => sum + parseFloat(t.amount || 0),
        0
      ),
      pendingAmount: [
        ...pendingTransfers,
        ...processingTransfers,
      ].reduce((sum: number, t: any) => sum + parseFloat(t.amount || 0), 0),
      failedAmount: failedTransfers.reduce((sum: number, t: any) => sum + parseFloat(t.amount || 0), 0),
      totalCompleted: completedTransfers.reduce(
        (sum: number, t: any) => sum + parseFloat(t.amount || 0),
        0
      ),
      totalPending: [
        ...pendingTransfers,
        ...processingTransfers,
      ].reduce((sum: number, t: any) => sum + parseFloat(t.amount || 0), 0),
      successRate:
        transfers.length > 0
          ? (completedTransfers.length / transfers.length) * 100
          : 0,
    }

    console.log('[Transfers API] Fetched transfer history for merchant:', merchantId, stats)

    return NextResponse.json({
      transfers,
      stats,
      merchantId,
    })
  } catch (error) {
    console.error('[Transfers API] GET error:', error)
    return NextResponse.json({ error: 'Failed to fetch transfer history' }, { status: 500 })
  }
}

/**
 * PUT /api/transfers/process
 * Manually retry a failed transfer
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const transferId = body.transferId

    if (!transferId) {
      return NextResponse.json({ error: 'transferId required' }, { status: 400 })
    }

    const { retryTransfer } = await import('@/lib/transfer-service')
    const result = await retryTransfer(transferId)

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Retry failed' }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: 'Transfer retry initiated',
      transferId,
    })
  } catch (error) {
    console.error('[Transfers API] PUT error:', error)
    return NextResponse.json({ error: 'Failed to retry transfer' }, { status: 500 })
  }
}

/**
 * Execute transfer in background without blocking
 */
async function executeTransferAsync(
  transferId: string,
  merchantAddress: string,
  amount: number
) {
  try {
    console.log('[Transfers API] Background transfer starting for transferId:', transferId)

    // Small delay to ensure transaction is fully recorded
    await new Promise((resolve) => setTimeout(resolve, 500))

    const result = await executeTransfer(transferId, merchantAddress, amount)

    console.log('[Transfers API] ========================================')
    console.log('[Transfers API] TRANSFER EXECUTION RESULT')
    console.log('[Transfers API] transferId:', transferId)
    console.log('[Transfers API] merchantAddress:', merchantAddress)
    console.log('[Transfers API] amount:', amount)
    console.log('[Transfers API] success:', result.success)
    console.log('[Transfers API] piTransferId:', result.piTransferId)
    console.log('[Transfers API] error:', result.error)
    console.log('[Transfers API] ========================================')

    if (!result.success) {
      console.error('[Transfers API] ❌ Transfer FAILED:', {
        transferId,
        merchantAddress,
        amount,
        error: result.error,
      })
      return
    }

    console.log('[Transfers API] ✓ Transfer SUCCEEDED:', {
      transferId,
      piTransferId: result.piTransferId,
      amount,
      merchantAddress,
    })
  } catch (error) {
    console.error('[Transfers API] Background transfer exception:', error)
  }
}
