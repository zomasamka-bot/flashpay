import {financialNetwork} from './financial-network'
/** R36 certification preflight, quarantined. Never issues approvals or changes financial state.
 * Evidence must be independently obtained; caller assertions cannot grant authorization.
 * History/accounting inputs are deliberately NOT accepted as booleans.
 */
import { createHash } from 'node:crypto'
import { checkR36HorizonAgainstDurableRecords } from './r36-horizon-durable-evidence-gate'
import type { R36HorizonProofInput } from './r36-independent-horizon-proof'
import { reviewR36SignedEvidence, type R36SignedReviewInput, type R36SignatureReview } from './r36-signed-evidence-review'

type Db = { query(sql: string, params: readonly unknown[]): Promise<{rows: Record<string,unknown>[]}> }
export type Preflight = Readonly<{ outcome:'BLOCKED'|'HORIZON_MATCHED_HISTORY_UNCERTIFIED'; reason:string; authorizesRotation:false; horizonComparisonDigest?:string; signatureReview?:R36SignatureReview }>
const blocked = (reason:string):Preflight => ({outcome:'BLOCKED',reason,authorizesRotation:false})
/** Legacy read-only diagnostic for an already observed outbound transaction.
 * It intentionally cannot rotate or issue an initial admission certificate. Use the
 * separate protected prepared-admission entry below for complete signed-body review.
 */
export async function preflightR36TrustedCertification(db:Db, input:R36HorizonProofInput, fetcher:typeof fetch, review?:R36SignedReviewInput):Promise<Preflight> {
  try {
    // Snapshot the expected binding before the first await; callers cannot replace it
    // between signature verification and the independent durable/Horizon comparison.
    review = review === undefined ? undefined : {...review, expected:{...review.expected}}
    // Optional, server-side diagnostic only. Missing policy and invalid signatures deny;
    // even a valid signature cannot override the existing certification/rotation block.
    const signatureReview = review === undefined ? undefined : reviewR36SignedEvidence(review)
    if (signatureReview?.outcome === 'BLOCKED') return blocked(`SIGNED_EVIDENCE_${signatureReview.reason}`)
    const horizon = await checkR36HorizonAgainstDurableRecords(db,input,fetcher)
    if(horizon.outcome !== 'MATCHED_NOT_AUTHORIZED' || !horizon.evidenceDigest)
      return blocked(`HORIZON_${horizon.reason}`)
    if (review) {
      const expectedBinding = review.expected
      if (!horizon.durableIdentity || !/^(0|[1-9][0-9]*)(\.[0-9]{1,7})?$/.test(input.amount)) return blocked('SIGNED_EVIDENCE_BINDING_UNAVAILABLE')
      const [whole, fraction = ''] = input.amount.split('.')
      const binding = { ...horizon.durableIdentity, network:input.network, sourceWallet:input.sourceWallet,
        preparedHash:input.preparedHash, preparedSequence:input.preparedSequence, destinationWallet:input.destinationWallet,
        amountStroops:(BigInt(whole)*BigInt(10000000)+BigInt(fraction.padEnd(7,'0'))).toString(), asset:'native',
        envelopeXdrTextSha256:createHash('sha256').update(input.envelopeXdr,'utf8').digest('hex'), horizonComparisonDigest:horizon.evidenceDigest }
      if (!Object.entries(binding).every(([key,value]) => expectedBinding[key as keyof typeof expectedBinding] === value))
        return blocked('SIGNED_EVIDENCE_DURABLE_OR_XDR_MISMATCH')
    }
    // A digest of a matched Horizon record is not a wallet-history reconciliation.
    // This diagnostic does not accept the complete signed history/accounting input contract.
    // The protected worker below performs that review; this read-only API grants nothing.
    return {outcome:'HORIZON_MATCHED_HISTORY_UNCERTIFIED',reason:'DIAGNOSTIC_ONLY_USE_PROTECTED_PREPARED_ADMISSION',authorizesRotation:false,horizonComparisonDigest:horizon.evidenceDigest,...(signatureReview ? {signatureReview} : {})}
  } catch { return blocked('PREFLIGHT_ERROR') }
}
/** Immutable audit correlation only; never a certificate or permission. */
export function r36EvidenceCorrelationId(network:string,wallet:string,hash:string):string|null {
  if(network!==financialNetwork()|| !/^G[A-Z2-7]{55}$/.test(wallet)|| !/^[0-9a-f]{64}$/.test(hash))return null
  return createHash('sha256').update(JSON.stringify([network,wallet,hash])).digest('hex')
}

/** Actual issuance entry: protected DB policy/request, authenticated full evidence,
 * separately controlled signer, atomic consumer. No caller approval boolean.
 * This issues only INITIAL_PREPARED_ADMISSION, never rotation/activation/resend. */
export {runR36CertificateWorker as certifyR36PreparedAdmission} from './r36-certificate-worker'
