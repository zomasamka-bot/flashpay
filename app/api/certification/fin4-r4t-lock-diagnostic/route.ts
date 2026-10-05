import { type NextRequest, NextResponse } from 'next/server'
import { fin4AuthorizeRunId } from '@/lib/fin4-live-certification'
import { readFin4R4TSubmitLockDiagnostic } from '@/lib/fin4-r4t-lock-probe'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const runId = fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))
  if (!runId) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const sourceWallet = process.env.FLASHPAY_PI_PUBLIC_KEY?.trim() ?? ''
  const diagnostic = await readFin4R4TSubmitLockDiagnostic(sourceWallet)

  return NextResponse.json({
    ok: diagnostic.state !== 'unavailable',
    action: 'fin4-r4t-lock-diagnostic',
    runId,
    sourceWallet,
    lockDiagnostic: diagnostic,
    lockAcquisitionExecuted: false,
    redisMutationExecuted: false,
    piMutationExecuted: false,
    horizonSubmitExecuted: false,
    financialAuthorityMutated: false,
  }, { status: diagnostic.state === 'unavailable' ? 409 : 200 })
}
