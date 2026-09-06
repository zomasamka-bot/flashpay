import { timingSafeEqual } from 'crypto'
import { type NextRequest, NextResponse } from 'next/server'
import { serverConfig } from '@/lib/server-config'
import { executeRefundNextStep } from '@/lib/refund-executor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supplied = request.headers.get('x-refund-internal-secret')
  if (!serverConfig.refundInternalSecret || !supplied) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const expectedBuffer = Buffer.from(serverConfig.refundInternalSecret)
  const suppliedBuffer = Buffer.from(supplied)
  if (expectedBuffer.length !== suppliedBuffer.length || timingSafeEqual(expectedBuffer, suppliedBuffer) !== true) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const body = await request.json()
    if (typeof body?.refundId !== 'string' || body.refundId.length === 0) {
      return NextResponse.json({ error: 'Invalid refundId' }, { status: 400 })
    }
    const result = await executeRefundNextStep(body.refundId)
    return NextResponse.json(result, { status: result.outcome === 'ready_for_submission' || result.outcome === 'found' ? 200 : 409 })
  } catch {
    return NextResponse.json({ outcome: 'blocked', reason: 'unavailable' }, { status: 503 })
  }
}
