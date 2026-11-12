import {createHash} from 'node:crypto'
import {validateMerchantFeeQuote, type MerchantFeeQuote} from './merchant-fee-contract'

/** Domain-separated, deterministic future intent binding. Not a certificate,
 * signature, issuer approval, finality proof or accounting authorization.
 * The original R36 V1 certificate bytes and guards remain unchanged.
 */
export function merchantQuoteBinding(value: MerchantFeeQuote): Readonly<{canonical: string; sha256: string}> {
  const canonical = JSON.stringify(validateMerchantFeeQuote(value))
  return Object.freeze({canonical,sha256:createHash('sha256').update('FLASHpay:MERCHANT_QUOTE:V1\n'+canonical).digest('hex')})
}
export function assertStoredQuoteMatches(stored: MerchantFeeQuote, expected: {
  paymentId:string; merchantUid:string; applicationId:string; network:string; grossStroops:string;
  sha256:string;
}): MerchantFeeQuote {
  const q = validateMerchantFeeQuote(stored), b = merchantQuoteBinding(q)
  if (q.paymentId !== expected.paymentId || q.merchantUid !== expected.merchantUid ||
      q.policy.applicationId !== expected.applicationId || q.policy.network !== expected.network ||
      q.grossStroops !== expected.grossStroops || b.sha256 !== expected.sha256) throw Error('FEE_STORED_BINDING_MISMATCH')
  return q
}
