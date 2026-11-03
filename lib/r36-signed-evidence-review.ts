/** Quarantined R36 signature review. NOT an issuer, certificate, or financial permission.
 * DRAFT protocol: independent approval of schema, trust root and finality policy is still
 * required. No environment fallback, embedded key, key discovery, network or persistence.
 * The policy and expected binding must come from a separately trusted server-side reviewer,
 * never from the envelope or an HTTP caller. This module is not a public route.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const R36_REVIEW_BINDING_FIELDS = [
  'network', 'sourceWallet', 'paymentId', 'operationKind', 'operationId',
  'preparedHash', 'preparedSequence', 'piPaymentId', 'u2aTxid',
  'destinationWallet', 'amountStroops', 'asset', 'envelopeXdrTextSha256',
  'horizonComparisonDigest', 'evidenceInventoryDigest', 'historyInventoryDigest',
  'accountingDigest', 'finalityPolicyDigest', 'cutoffLedger', 'unresolvedCases', 'nonce',
] as const
type BindingField = typeof R36_REVIEW_BINDING_FIELDS[number]
export type R36ReviewBinding = Readonly<Record<BindingField, string>>
const fields = ['schema', 'audience', 'policyDigest', 'issuerId', 'keyId',
  ...R36_REVIEW_BINDING_FIELDS, 'issuedAt', 'expiresAt'] as const
type Manifest = Record<typeof fields[number], string>
const domain = 'FLASHpay:R36:SIGNED_EVIDENCE_REVIEW:V1\n'
const hex = /^[0-9a-f]{64}$/
const uint = /^(0|[1-9][0-9]*)$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const identifier = /^[A-Za-z0-9_.:-]{1,128}$/
const wallet = /^G[A-Z2-7]{55}$/
export type R36ReviewPolicy = Readonly<{
  policyDigest: string; issuerId: string; keyId: string;
  publicKeyPem: string; publicKeySpkiSha256: string; finalityPolicyDigest: string;
  validFrom: number; validUntil: number; maxAgeSeconds: number;
  revocationCheckedAt: number; revocationValidUntil: number;
  revokedKeyIds: readonly string[]; revokedEvidenceDigests: readonly string[];
}>
export type R36SignedReviewInput = Readonly<{
  envelope: unknown; expected: R36ReviewBinding; policy?: R36ReviewPolicy;
  /** Trusted evaluation clock, never taken from the envelope. Defaults to wall clock. */
  nowSeconds?: number;
}>
export type R36SignatureReview = Readonly<{
  outcome: 'BLOCKED' | 'SIGNATURE_BOUND_NOT_CERTIFIED'; reason: string;
  authorizesRotation: false; authorizesActivation: false; authorizesIssuance: false;
  authorizesSubmission: false; replayConsumed: false; manifestDigest?: string;
}>
const result = (reason: string, manifestDigest?: string): R36SignatureReview => ({
  outcome: manifestDigest ? 'SIGNATURE_BOUND_NOT_CERTIFIED' : 'BLOCKED', reason,
  authorizesRotation: false, authorizesActivation: false, authorizesIssuance: false,
  authorizesSubmission: false, replayConsumed: false, ...(manifestDigest ? { manifestDigest } : {}),
})
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' &&
  !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
const exactKeys = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k))
const epoch = (x: number) => Number.isSafeInteger(x) && x >= 0

/** Exact ordered UTF-8 string tuple, not arbitrary JSON hashing. All values are bounded
 * ASCII strings; amounts and sequences are decimal strings. No trimming/coercion.
 * A signature authenticates these bytes only: it does NOT certify their truth, approve
 * the policy, prove Pi lifecycle/finality, or atomically consume a nonce. Repeated reviews
 * confer no authority. A future issuer needs a separate durable replay transaction.
 */
export function reviewR36SignedEvidence(input: R36SignedReviewInput): R36SignatureReview {
  try {
    const p = input.policy
    if (!p) return result('TRUST_ROOT_NOT_CONFIGURED')
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (!epoch(now) || ![p.validFrom, p.validUntil, p.revocationCheckedAt, p.revocationValidUntil].every(epoch) ||
        !Number.isSafeInteger(p.maxAgeSeconds) || p.maxAgeSeconds <= 0 ||
        !hex.test(p.policyDigest) || !hex.test(p.publicKeySpkiSha256) || !hex.test(p.finalityPolicyDigest) ||
        !identifier.test(p.issuerId) || !identifier.test(p.keyId) ||
        !Array.isArray(p.revokedKeyIds) || !p.revokedKeyIds.every(x => typeof x === 'string' && identifier.test(x)) ||
        !Array.isArray(p.revokedEvidenceDigests) || !p.revokedEvidenceDigests.every(x => typeof x === 'string' && hex.test(x)))
      return result('INVALID_REVIEW_POLICY')
    if (p.validFrom > now || now >= p.validUntil) return result('POLICY_NOT_CURRENT')
    if (p.revocationCheckedAt > now || now >= p.revocationValidUntil || p.revocationValidUntil > p.validUntil)
      return result('REVOCATION_STATUS_NOT_CURRENT')
    if (p.revokedKeyIds.includes(p.keyId)) return result('ISSUER_KEY_REVOKED')
    const e = input.envelope
    if (!object(e) || !exactKeys(e, ['manifest', 'signature']) || !object(e.manifest) ||
        !exactKeys(e.manifest, fields) || typeof e.signature !== 'string' || e.signature.length !== 88)
      return result('INVALID_SIGNED_ENVELOPE')
    const m = e.manifest
    if (!fields.every(k => typeof m[k] === 'string' && /^[\x20-\x7e]{1,256}$/.test(m[k] as string)))
      return result('INVALID_MANIFEST_FIELD')
    const manifest = m as Manifest
    if (manifest.schema !== 'R36_SIGNED_EVIDENCE_REVIEW_V1' || manifest.audience !== 'FLASHpay:R36:review' ||
        manifest.policyDigest !== p.policyDigest || manifest.issuerId !== p.issuerId || manifest.keyId !== p.keyId ||
        manifest.finalityPolicyDigest !== p.finalityPolicyDigest) return result('POLICY_OR_ISSUER_MISMATCH')
    if (manifest.network !== 'Pi Testnet' || !wallet.test(manifest.sourceWallet) || !wallet.test(manifest.destinationWallet) ||
        !uuid.test(manifest.paymentId) || !identifier.test(manifest.operationId) ||
        (manifest.operationKind === 'refund' && !uuid.test(manifest.operationId)) ||
        !['settlement', 'refund'].includes(manifest.operationKind) || !identifier.test(manifest.piPaymentId) ||
        manifest.asset !== 'native' || !/^[1-9][0-9]{0,18}$/.test(manifest.preparedSequence) ||
        !/^[1-9][0-9]{0,18}$/.test(manifest.amountStroops) || !/^[1-9][0-9]{0,9}$/.test(manifest.cutoffLedger) ||
        !['preparedHash','u2aTxid','envelopeXdrTextSha256','horizonComparisonDigest',
          'evidenceInventoryDigest','historyInventoryDigest','accountingDigest','finalityPolicyDigest','nonce']
          .every(k => hex.test(manifest[k as keyof Manifest]))) return result('INVALID_EVIDENCE_BINDING')
    if (manifest.unresolvedCases !== '0') return result('UNRESOLVED_HISTORY_OR_ACCOUNTING')
    if (!object(input.expected) || !exactKeys(input.expected, R36_REVIEW_BINDING_FIELDS) ||
        !R36_REVIEW_BINDING_FIELDS.every(k => manifest[k] === input.expected[k]))
      return result('EXPECTED_IDENTITY_OR_NONCE_MISMATCH')
    if (!uint.test(manifest.issuedAt) || !uint.test(manifest.expiresAt)) return result('INVALID_VALIDITY_INTERVAL')
    const issued = Number(manifest.issuedAt), expires = Number(manifest.expiresAt)
    if (!epoch(issued) || !epoch(expires) || issued < p.validFrom || issued > now || expires <= now ||
        expires <= issued || expires > p.validUntil || expires - issued > p.maxAgeSeconds ||
        p.revocationCheckedAt < issued) return result('STALE_OR_FUTURE_EVIDENCE')
    const signature = Buffer.from(e.signature, 'base64')
    if (signature.length !== 64 || signature.toString('base64') !== e.signature) return result('INVALID_SIGNATURE_ENCODING')
    const key = createPublicKey(p.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519' ||
        createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex') !== p.publicKeySpkiSha256)
      return result('PINNED_PUBLIC_KEY_MISMATCH')
    const bytes = Buffer.from(domain + JSON.stringify(fields.map(k => manifest[k])), 'utf8')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (p.revokedEvidenceDigests.includes(digest)) return result('EVIDENCE_REVOKED')
    if (!verify(null, bytes, key, signature)) return result('SIGNATURE_INVALID')
    return result('SIGNATURE_ONLY_INDEPENDENT_CERTIFICATION_AND_DURABLE_REPLAY_REQUIRED', digest)
  } catch { return result('SIGNATURE_REVIEW_FAILED') }
}
