import { type NextRequest, NextResponse } from 'next/server'
import { isRedisConfigured } from '@/lib/redis'
import { verifyRefundTables } from '@/lib/refund-checkpoint-store'
import { serverConfig } from '@/lib/server-config'
import { createRefundIntentInternal } from '@/lib/refund-intent-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const INTERNAL_SECRET = serverConfig.refundInternalSecret

function hasInternalAuthorization(request: NextRequest): boolean {
  if (!INTERNAL_SECRET) return false
  const supplied = request.headers.get('x-refund-internal-secret')
  return supplied === INTERNAL_SECRET
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function POST(request: NextRequest) {
  try {
    if (!hasInternalAuthorization(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders })
    }
    if (!isRedisConfigured) {
      return NextResponse.json({ error: 'Refund store unavailable' }, { status: 503, headers: corsHeaders })
    }
    const tablesReady = await verifyRefundTables()
    if (!tablesReady) {
      return NextResponse.json({ error: 'Refund tables unavailable' }, { status: 503, headers: corsHeaders })
    }
    const body = await request.json()
    const { paymentId, idempotencyKey } = body

    console.log('[refunds/intent] Request received:', { paymentId, idempotencyKey })

    if (!paymentId || typeof paymentId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid paymentId' },
        { status: 400, headers: corsHeaders }
      )
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid idempotencyKey' },
        { status: 400, headers: corsHeaders }
      )
    }

    const result = await createRefundIntentInternal(paymentId, idempotencyKey)
    return NextResponse.json(result.body, { status: result.status, headers: corsHeaders })
  } catch (error) {
    console.error('[refunds/intent] Unhandled error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: corsHeaders }
    )
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders })
}
