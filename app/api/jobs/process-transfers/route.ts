/**
 * Background job endpoint for processing pending transfers
 * GET /api/jobs/process-transfers
 * Call periodically (e.g., every 5 minutes) to retry failed transfers
 */

import { NextRequest, NextResponse } from 'next/server'
import { processPendingTransfers } from '@/lib/transfer-service'

export async function GET(request: NextRequest) {
  try {
    // Verify the request is from an authorized source (internal cron job)
    const authHeader = request.headers.get('Authorization')
    const expectedAuth = `Bearer ${process.env.TRANSFER_JOB_SECRET || 'local-dev'}`

    if (process.env.NODE_ENV === 'production' && authHeader !== expectedAuth) {
      console.warn('[Job] Unauthorized attempt to call process-transfers')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log('[Job] Starting background transfer processing job')

    // Process pending transfers
    const result = await processPendingTransfers()

    console.log('[Job] Transfer processing complete:', result)

    return NextResponse.json({
      status: 'success',
      message: 'Transfer processing completed',
      result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Job] Background job failed:', error)
    return NextResponse.json(
      {
        status: 'error',
        message: 'Background job failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/jobs/process-transfers
 * Manual trigger for transfer processing
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization')
    const expectedAuth = `Bearer ${process.env.TRANSFER_JOB_SECRET || 'local-dev'}`

    if (process.env.NODE_ENV === 'production' && authHeader !== expectedAuth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log('[Job] Manual transfer processing triggered')

    const result = await processPendingTransfers()

    return NextResponse.json({
      status: 'success',
      message: 'Transfer processing triggered',
      result,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Job] Manual job failed:', error)
    return NextResponse.json(
      {
        status: 'error',
        message: 'Processing failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  }
}
