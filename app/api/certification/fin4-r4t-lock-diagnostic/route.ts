import { type NextRequest, NextResponse } from 'next/server'
import { fin4AuthorizeRunId } from '@/lib/fin4-live-certification'
import { readFin4R4TSubmitLockDiagnostic } from '@/lib/fin4-r4t-lock-probe'
import { getSettlementCheckpointAuthoritative } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const runId = fin4AuthorizeRunId(request.headers.get('x-flashpay-fin4-run-id'))
  if (!runId) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const paymentB = process.env.FLASHPAY_FIN4_PAYMENT_B?.trim() ?? ''
  if (!paymentB) {
    return NextResponse.json({
      ok: false, action: 'fin4-r4t-lock-diagnostic', runId,
      reason: 'ARMED_PAYMENT_B_UNAVAILABLE',
      lockAcquisitionExecuted: false, redisMutationExecuted: false,
      piMutationExecuted: false, horizonSubmitExecuted: false, financialAuthorityMutated: false,
    }, { status: 409 })
  }

  const durable = await getSettlementCheckpointAuthoritative(paymentB)
  if (
    durable.outcome !== 'FOUND' ||
    durable.checkpoint.paymentId !== paymentB ||
    durable.checkpoint.stage !== 'a2u_created' ||
    !durable.checkpoint.a2uFromAddress ||
    durable.checkpoint.preparedEnvelopeXdr !== undefined ||
    durable.checkpoint.preparedTxHash !== undefined ||
    durable.checkpoint.preparedSequence !== undefined ||
    durable.checkpoint.a2uTxid !== undefined
  ) {
    return NextResponse.json({
      ok: false, action: 'fin4-r4t-lock-diagnostic', runId, paymentB,
      reason: 'DURABLE_STAGE1_SOURCE_WALLET_UNPROVEN',
      durableOutcome: durable.outcome,
      durableStage: durable.outcome === 'FOUND' ? durable.checkpoint.stage : null,
      lockAcquisitionExecuted: false, redisMutationExecuted: false,
      piMutationExecuted: false, horizonSubmitExecuted: false, financialAuthorityMutated: false,
    }, { status: 409 })
  }

  const sourceWallet = durable.checkpoint.a2uFromAddress
  const diagnostic = await readFin4R4TSubmitLockDiagnostic(sourceWallet)

  return NextResponse.json({
    ok: diagnostic.state !== 'unavailable',
    action: 'fin4-r4t-lock-diagnostic',
    runId, paymentB, sourceWallet,
    sourceWalletAuthority: 'postgres_settlement_checkpoint_a2u_created',
    lockDiagnostic: diagnostic,
    lockAcquisitionExecuted: false,
    redisMutationExecuted: false,
    piMutationExecuted: false,
    horizonSubmitExecuted: false,
    financialAuthorityMutated: false,
  }, { status: diagnostic.state === 'unavailable' ? 409 : 200 })
}
