/** R36 certification preflight, quarantined. Never issues approvals or changes financial state.
 * Evidence must be independently obtained; caller assertions cannot grant authorization.
 * History/accounting inputs are deliberately NOT accepted as booleans.
 */
import { createHash } from 'node:crypto'
import { checkR36HorizonAgainstDurableRecords } from './r36-horizon-durable-evidence-gate'
import type { R36HorizonProofInput } from './r36-independent-horizon-proof'

type Db = { query(sql: string, params: readonly unknown[]): Promise<{rows: Record<string,unknown>[]}> }
export type Preflight = Readonly<{ outcome:'BLOCKED'|'HORIZON_MATCHED_HISTORY_UNCERTIFIED'; reason:string; authorizesRotation:false; horizonComparisonDigest?:string }>
const blocked = (reason:string):Preflight => ({outcome:'BLOCKED',reason,authorizesRotation:false})
/** No issuer is exposed until wallet-scoped historical reconciliation and accounting finality
 * can be verified from locked authoritative rows and independent outbound inventory.
 */
export async function preflightR36TrustedCertification(db:Db, input:R36HorizonProofInput, fetcher:typeof fetch):Promise<Preflight> {
  try {
    const horizon = await checkR36HorizonAgainstDurableRecords(db,input,fetcher)
    if(horizon.outcome !== 'MATCHED_NOT_AUTHORIZED' || !horizon.evidenceDigest)
      return blocked(`HORIZON_${horizon.reason}`)
    // A digest of a matched Horizon record is not a wallet-history reconciliation.
    // The separate accounting and historical checks remain unavailable here; fail closed.
    return {outcome:'HORIZON_MATCHED_HISTORY_UNCERTIFIED',reason:'HISTORY_AND_ACCOUNTING_CERTIFICATION_NOT_IMPLEMENTED',authorizesRotation:false,horizonComparisonDigest:horizon.evidenceDigest}
  } catch { return blocked('PREFLIGHT_ERROR') }
}
/** Immutable audit correlation only; never a certificate or permission. */
export function r36EvidenceCorrelationId(network:string,wallet:string,hash:string):string|null {
  if(network!=='Pi Testnet'|| !/^G[A-Z2-7]{55}$/.test(wallet)|| !/^[0-9a-f]{64}$/.test(hash))return null
  return createHash('sha256').update(JSON.stringify([network,wallet,hash])).digest('hex')
}
