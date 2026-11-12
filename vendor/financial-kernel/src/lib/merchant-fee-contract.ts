/** Preparation contract only. A quote is not permission to collect or send funds.
 * Values are decimal strings in stroops: no binary floating-point fee arithmetic.
 * Existing V1 financial execution remains zero-commission until V2 is qualified.
 */
export type FinancialNetwork = 'Pi Testnet' | 'Pi Network'
export type MerchantFeePolicy = Readonly<{
  schema: 'MERCHANT_FEE_POLICY_V1'; id: string; applicationId: string;
  network: FinancialNetwork; payer: 'merchant'; basisPoints: number;
  rounding: 'floor'; networkFeePayer: 'application';
  refund: 'full_customer_amount_no_earned_commission';
}>
export type MerchantFeeQuote = Readonly<{
  schema: 'MERCHANT_FEE_QUOTE_V1'; paymentId: string; merchantUid: string;
  policy: MerchantFeePolicy; grossStroops: string; merchantNetStroops: string;
  commissionStroops: string;
}>
export const MAX_PAYMENT_STROOPS = 10_000_000_000_000n
function exactKeys(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).sort().join(',') !== fields.sort().join(',')) throw Error('FEE_CONTRACT_FIELDS')
}
function id(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)) throw Error('FEE_CONTRACT_IDENTITY')
}
export function stroops(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,13})$/.test(value)) throw Error('FEE_CONTRACT_PRECISION')
  const n = BigInt(value)
  if (n > MAX_PAYMENT_STROOPS || n < (allowZero ? 0n : 1n)) throw Error('FEE_CONTRACT_AMOUNT')
  return n
}
export function piToExactStroops(value: string): string {
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,7})?$/.test(value)) throw Error('FEE_CONTRACT_PRECISION')
  const [whole, fraction = ''] = value.split('.')
  const n = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
  return stroops(n.toString()).toString()
}
export function validateMerchantFeePolicy(value: unknown): MerchantFeePolicy {
  exactKeys(value, ['schema','id','applicationId','network','payer','basisPoints','rounding','networkFeePayer','refund'])
  id(value.id); id(value.applicationId)
  if (value.schema !== 'MERCHANT_FEE_POLICY_V1' || !['Pi Testnet','Pi Network'].includes(String(value.network)) ||
      value.payer !== 'merchant' || !Number.isInteger(value.basisPoints) ||
      (value.basisPoints as number) < 0 || (value.basisPoints as number) >= 10_000 ||
      value.rounding !== 'floor' || value.networkFeePayer !== 'application' ||
      value.refund !== 'full_customer_amount_no_earned_commission') throw Error('FEE_POLICY_INVALID')
  return Object.freeze({schema:'MERCHANT_FEE_POLICY_V1', id:value.id, applicationId:value.applicationId,
    network:value.network as FinancialNetwork, payer:'merchant', basisPoints:value.basisPoints as number,
    rounding:'floor', networkFeePayer:'application', refund:'full_customer_amount_no_earned_commission'})
}
export function quoteMerchantFee(policy: MerchantFeePolicy, paymentId: string, merchantUid: string, grossStroops: string): MerchantFeeQuote {
  const p = validateMerchantFeePolicy(policy); id(paymentId); id(merchantUid)
  const gross = stroops(grossStroops), fee = gross * BigInt(p.basisPoints) / 10_000n
  return Object.freeze({schema:'MERCHANT_FEE_QUOTE_V1',paymentId,merchantUid,policy:p,
    grossStroops:gross.toString(),merchantNetStroops:(gross-fee).toString(),commissionStroops:fee.toString()})
}
export function validateMerchantFeeQuote(value: unknown): MerchantFeeQuote {
  exactKeys(value, ['schema','paymentId','merchantUid','policy','grossStroops','merchantNetStroops','commissionStroops'])
  if (value.schema !== 'MERCHANT_FEE_QUOTE_V1') throw Error('FEE_QUOTE_VERSION')
  id(value.paymentId); id(value.merchantUid)
  const q = quoteMerchantFee(validateMerchantFeePolicy(value.policy), value.paymentId, value.merchantUid, String(value.grossStroops))
  // Types and exact canonical representation matter; no coercion on money fields.
  if (typeof value.grossStroops !== 'string' || value.merchantNetStroops !== q.merchantNetStroops ||
      value.commissionStroops !== q.commissionStroops) throw Error('FEE_QUOTE_MISMATCH')
  return q
}
export function quoteOutcome(value: MerchantFeeQuote, outcome: 'settlement' | 'refund', networkFeeStroops: string) {
  const q = validateMerchantFeeQuote(value), networkFee = stroops(networkFeeStroops, true)
  if (outcome !== 'settlement' && outcome !== 'refund') throw Error('FEE_OUTCOME_INVALID')
  const commission = outcome === 'settlement' ? BigInt(q.commissionStroops) : 0n
  return Object.freeze({outcome, customerAmountStroops:q.grossStroops,
    merchantCreditStroops:outcome === 'settlement' ? q.merchantNetStroops : '0',
    customerRefundStroops:outcome === 'refund' ? q.grossStroops : '0',
    earnedCommissionStroops:commission.toString(),networkFeeStroops:networkFee.toString(),
    applicationNetImpactStroops:(commission-networkFee).toString()})
}
/** Unchanged active contract. This is deliberately not relaxed by draft quotes. */
export {isLegacyZeroCommission} from './active-financial-contract'
