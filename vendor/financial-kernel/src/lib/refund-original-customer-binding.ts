import "server-only"

import { getDurableU2AIngressAuthoritative, readSettlementRefundAuthority } from './db'
import { serverConfig } from './server-config'
import { numberToExactPositiveStroops } from './financial-amount-stroops'

/** Read-only fail-closed original customer binding. This is NOT merchant identity. */
export async function verifyRefundOriginalCustomerBinding(input: {
  paymentId: string; payerUid: string; amount: number;
  merchantId?: string; merchantUid?: string;
}): Promise<{ outcome: 'VERIFIED'; verifiedAt: string } | { outcome: 'BLOCKED' }> {
  const blocked = { outcome: 'BLOCKED' as const }
  try {
    if (!input.paymentId || !input.payerUid || numberToExactPositiveStroops(input.amount) === null ||
        !serverConfig.isPiApiKeyConfigured || !serverConfig.piApiKey) return blocked
    const authority = await readSettlementRefundAuthority(input.paymentId)
    if (authority.outcome !== 'CLEAR' || authority.settlementActive) return blocked
    const result = await getDurableU2AIngressAuthoritative(input.paymentId)
    if (result.outcome !== 'FOUND' || result.checkpoint.completedAt === null) return blocked
    const d = result.checkpoint
    if (d.paymentId !== input.paymentId || d.payerUid !== input.payerUid ||
        numberToExactPositiveStroops(d.customerAmount) !== numberToExactPositiveStroops(input.amount) ||
        (input.merchantId !== undefined && d.merchantId !== input.merchantId) ||
        (input.merchantUid !== undefined && d.merchantUid !== input.merchantUid)) return blocked
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(d.u2aIdentifier)}`, {
      method: 'GET', headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error',
    })
    if (!response.ok) return blocked
    const raw: unknown = await response.json()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blocked
    const dto = raw as Record<string, unknown>
    const metadata = dto.metadata && typeof dto.metadata === 'object' && !Array.isArray(dto.metadata) ? dto.metadata as Record<string, unknown> : null
    const transaction = dto.transaction && typeof dto.transaction === 'object' && !Array.isArray(dto.transaction) ? dto.transaction as Record<string, unknown> : null
    const status = dto.status && typeof dto.status === 'object' && !Array.isArray(dto.status) ? dto.status as Record<string, unknown> : null
    if (dto.identifier !== d.u2aIdentifier || dto.direction !== 'user_to_app' ||
        numberToExactPositiveStroops(Number(dto.amount)) !== numberToExactPositiveStroops(d.customerAmount) ||
        dto.user_uid !== d.payerUid || (metadata?.paymentId !== undefined && metadata.paymentId !== input.paymentId) ||
        transaction?.txid !== d.u2aTxid || transaction?.verified !== true ||
        status?.developer_approved !== true || status?.transaction_verified !== true ||
        status?.developer_completed !== true || status?.cancelled === true || status?.user_cancelled === true) return blocked
    return { outcome: 'VERIFIED', verifiedAt: d.verifiedAt }
  } catch { return blocked }
}
