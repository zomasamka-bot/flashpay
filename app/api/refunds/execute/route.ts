import { type NextRequest, NextResponse } from 'next/server'
import { serverConfig } from '@/lib/server-config'
import { executeRefundCreation } from '@/lib/refund-executor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!serverConfig.refundInternalSecret || request.headers.get('x-refund-internal-secret') !== serverConfig.refundInternalSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await request.json()
    if (typeof body?.refundId !== 'string' || body.refundId.length === 0) {
      return NextResponse.json({ error: 'Invalid refundId' }, { status: 400 })
    }
    const result = await executeRefundCreation(body.refundId)
    return NextResponse.json(result, { status: result.outcome === 'ready_for_submission' || result.outcome === 'found' ? 200 : 409 })
  } catch {
    return NextResponse.json({ outcome: 'blocked', reason: 'unavailable' }, { status: 503 })
  }
}
