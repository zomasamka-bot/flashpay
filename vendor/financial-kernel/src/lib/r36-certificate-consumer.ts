/** NOT_FOR_DEPLOY. Dedicated trusted-verifier worker interface, never an app route.
 * No issuer identity/key is provisioned by this module. Policy and immutable expected
 * intent must be installed independently in protected PostgreSQL tables. A runtime
 * client cannot register evidence. No signing, wallet activation, rotation or network.
 */
import { createHash, createPublicKey, verify } from 'node:crypto'

export const R36_ADMISSION_FIELDS = [
  'network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence',
  'piPaymentId','u2aTxid','destinationWallet','amountStroops','envelopeXdrTextSha256',
  'immutableIntentDigest','inboundFinalityDigest','walletHistoryDigest','accountingDigest',
  'clearanceDigest','exceptionsDigest','exceptionIsolationDigest','cutoffLedger','nonce',
] as const
const fields = ['schema','purpose','issuerId','keyId','policyDigest',...R36_ADMISSION_FIELDS,'issuedAt','expiresAt'] as const
const domain = 'FLASHpay:R36:INITIAL_ADMISSION:V1\n'
const hex = /^[0-9a-f]{64}$/
type Sql = { unsafe(sql:string, values?:unknown[]):Promise<Record<string,unknown>[]> }
export type R36CertificateDatabase = { begin<T>(run:(tx:Sql)=>Promise<T>):Promise<T> }
export type R36CertificateResult = Readonly<{
  outcome:'BLOCKED'|'RECORDED'|'REPLAYED'; reason:string; certificateDigest?:string;
  authorizesFinancialRelease:false; authorizesRotation:false; authorizesWalletActivation:false;
}>
const result = (outcome:R36CertificateResult['outcome'], reason:string, certificateDigest?:string):R36CertificateResult =>
  ({outcome,reason,authorizesFinancialRelease:false,authorizesRotation:false,authorizesWalletActivation:false,...(certificateDigest?{certificateDigest}:{})})
const object = (x:unknown):x is Record<string,unknown> => !!x && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype
const exact = (x:Record<string,unknown>, names:readonly string[]) => Object.keys(x).length===names.length && names.every(n=>Object.hasOwn(x,n))
const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex')

/** Registers a signed INITIAL admission in one transaction. Outgoing finality is not
 * required here: it does not exist before submission. Instead the independently signed
 * inbound finality, immutable prepared intent, wallet history/accounting and separately
 * approved clearance are all bound to a protected expected request. The original wallet
 * activation, authority, XOR and one-shot gates still decide admission. A recorded
 * receipt does not itself enable a wallet or send money.
 * Database receipt-write privileges MUST be exclusive to the independently controlled
 * verifier worker. PostgreSQL trusts that principal; it does not implement Ed25519.
 */
export async function consumeR36AdmissionCertificate(db:R36CertificateDatabase, envelope:unknown):Promise<R36CertificateResult> {
  try {
    // Snapshot before any await, reject unknown fields and non-JSON object shapes.
    if (!object(envelope) || !exact(envelope,['manifest','signature']) || !object(envelope.manifest) ||
        !exact(envelope.manifest,fields) || typeof envelope.signature!=='string') return result('BLOCKED','INVALID_ENVELOPE')
    const m={...envelope.manifest}, signature=envelope.signature
    if (!fields.every(k=>typeof m[k]==='string' && /^[\x20-\x7e]{1,256}$/.test(m[k] as string))) return result('BLOCKED','INVALID_FIELD')
    const manifest=m as Record<typeof fields[number],string>
    if (manifest.schema!=='R36_ADMISSION_CERTIFICATE_V1' || manifest.purpose!=='INITIAL_PREPARED_ADMISSION' ||
        manifest.network!=='Pi Testnet' || !hex.test(manifest.nonce) || !hex.test(manifest.policyDigest) ||
        !/^(0|[1-9][0-9]*)$/.test(manifest.issuedAt) || !/^[1-9][0-9]*$/.test(manifest.expiresAt)) return result('BLOCKED','INVALID_CERTIFICATE_SCOPE')
    if (!/^G[A-Z2-7]{55}$/.test(manifest.sourceWallet)||!/^G[A-Z2-7]{55}$/.test(manifest.destinationWallet)||
        !['settlement','refund'].includes(manifest.operationKind)||
        !['paymentId','operationId','piPaymentId'].every(k=>/^[A-Za-z0-9_.:-]{1,128}$/.test(manifest[k as keyof typeof manifest]))||
        !['preparedSequence','amountStroops','cutoffLedger'].every(k=>/^[1-9][0-9]{0,29}$/.test(manifest[k as keyof typeof manifest]))||
        !['preparedHash','u2aTxid','envelopeXdrTextSha256','immutableIntentDigest','inboundFinalityDigest',
          'walletHistoryDigest','accountingDigest','clearanceDigest','exceptionsDigest','exceptionIsolationDigest']
          .every(k=>hex.test(manifest[k as keyof typeof manifest]))) return result('BLOCKED','INVALID_INTENT_BINDING')
    const issued=Number(manifest.issuedAt),expires=Number(manifest.expiresAt)
    if (!Number.isSafeInteger(issued)||!Number.isSafeInteger(expires)||issued<0||expires<=issued) return result('BLOCKED','INVALID_VALIDITY')
    const bytes=Buffer.from(domain+JSON.stringify(fields.map(k=>manifest[k])),'utf8')
    const digest=hash(bytes)
    const sig=Buffer.from(signature,'base64')
    if (sig.length!==64 || sig.toString('base64')!==signature) return result('BLOCKED','INVALID_SIGNATURE_ENCODING')
    return await db.begin(async tx=>{
      // This SECURITY DEFINER read locks policy and request to serialize revocation,
      // simultaneous consumption and crash/restart against the same immutable nonce.
      const rows=await tx.unsafe('SELECT public.r36_certificate_context($1) AS context',[manifest.nonce])
      const c=rows.length===1?rows[0].context:null
      if (!object(c)||!object(c.binding)||!object(c.policy)||typeof c.nowSeconds!=='number') return result('BLOCKED','TRUST_CONTEXT_UNAVAILABLE')
      const p=c.policy,expected=c.binding,now=c.nowSeconds
      if (!exact(expected,R36_ADMISSION_FIELDS) || !R36_ADMISSION_FIELDS.every(k=>manifest[k]===expected[k]) ||
          p.policyDigest!==manifest.policyDigest || p.issuerId!==manifest.issuerId || p.keyId!==manifest.keyId)
        return result('BLOCKED','TRUSTED_BINDING_MISMATCH')
      if (p.enabled!==true || p.revoked!==false || typeof p.validFrom!=='number'||typeof p.validUntil!=='number'||
          typeof p.maxAgeSeconds!=='number'||typeof p.revocationCheckedAt!=='number'||typeof p.revocationValidUntil!=='number'||
          ![now,p.validFrom,p.validUntil,p.maxAgeSeconds,p.revocationCheckedAt,p.revocationValidUntil].every(Number.isSafeInteger)||
          issued<p.validFrom || issued>now || expires<=now || expires>p.validUntil || now<p.validFrom ||
          expires-issued>p.maxAgeSeconds || p.maxAgeSeconds<=0 || p.revocationCheckedAt<issued ||
          p.revocationCheckedAt>now || now>=p.revocationValidUntil) return result('BLOCKED','TRUST_POLICY_NOT_CURRENT')
      if (typeof p.publicKeyPem!=='string'||typeof p.publicKeySpkiSha256!=='string'||!hex.test(p.publicKeySpkiSha256)) return result('BLOCKED','TRUST_ROOT_UNAVAILABLE')
      const key=createPublicKey(p.publicKeyPem)
      if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==p.publicKeySpkiSha256||
          !verify(null,bytes,key,sig)) return result('BLOCKED','SIGNATURE_OR_PIN_INVALID')
      // Revalidate clock/revocation in SQL after signature work. Receipt and the original
      // exact seven-field attestation are inserted together; any conflict rolls back both.
      const recorded=await tx.unsafe('SELECT public.r36_record_certificate($1,$2,$3::text::jsonb,$4) AS outcome',
        [manifest.nonce,digest,JSON.stringify(manifest),signature])
      const out=recorded.length===1?recorded[0].outcome:null
      if(out!=='RECORDED'&&out!=='REPLAYED') throw new Error('CERTIFICATE_COMMIT_DENIED')
      return result(out,'INITIAL_ADMISSION_RECORDED_SUBJECT_TO_ORIGINAL_R36_GATES',digest)
    })
  } catch { return result('BLOCKED','CERTIFICATE_TRANSACTION_FAILED') }
}
