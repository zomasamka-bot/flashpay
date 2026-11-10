import 'server-only'
import { serverConfig } from './server-config'

export type PiA2UQueueObservation = 'EMPTY' | 'BUSY' | 'UNAVAILABLE'

// Pi serializes server payments at app scope, including payments created under
// a previous wallet. Wallet isolation alone cannot establish provider readiness.
// This GET is a precollection check, not finality, a lock or financial authority.
// Never cancel, complete, adopt or resend a returned payment here.
export async function readPiA2UQueueAdmission(): Promise<PiA2UQueueObservation> {
  if (!serverConfig.piApiKey) return 'UNAVAILABLE'
  try {
    const response = await fetch('https://api.minepi.com/v2/payments/incomplete_server_payments', {
      method: 'GET',
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return 'UNAVAILABLE'
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'UNAVAILABLE'
    const entries = (body as Record<string, unknown>).incomplete_server_payments
    if (!Array.isArray(entries)) return 'UNAVAILABLE'
    // Any entry holds new collection. No wallet, amount or legacy-status filter
    // may turn an app-wide occupied provider slot into an empty observation.
    return entries.length === 0 ? 'EMPTY' : 'BUSY'
  } catch { return 'UNAVAILABLE' }
}
