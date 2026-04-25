/**
 * Export transfer history, reports, and statements
 * GET /api/transfers/export?format=csv|json&merchantId=xxx
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  exportTransfersToCSV,
  exportTransfersToJSON,
  generateTransferReport,
  generateStatement,
} from '@/lib/transfer-report-service'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') as 'csv' | 'json' | undefined
    const merchantId = searchParams.get('merchantId')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (!merchantId) {
      return NextResponse.json({ error: 'merchantId required' }, { status: 400 })
    }

    if (!format || !['csv', 'json'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format (csv or json required)' }, { status: 400 })
    }

    console.log('[Export API] Export requested', { format, merchantId })

    if (format === 'csv') {
      const csvContent = await exportTransfersToCSV(merchantId)

      return new NextResponse(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="transfers_${merchantId}_${Date.now()}.csv"`,
        },
      })
    }

    if (format === 'json') {
      const jsonData = await exportTransfersToJSON(merchantId)

      // Generate statement if date range provided
      if (startDate && endDate) {
        const statement = await generateStatement(
          merchantId,
          new Date(startDate),
          new Date(endDate)
        )
        jsonData.statement = statement
      }

      return NextResponse.json(jsonData, {
        status: 200,
        headers: {
          'Content-Disposition': `attachment; filename="transfers_${merchantId}_${Date.now()}.json"`,
        },
      })
    }
  } catch (error) {
    console.error('[Export API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to export transfers', details: String(error) },
      { status: 500 }
    )
  }
}
