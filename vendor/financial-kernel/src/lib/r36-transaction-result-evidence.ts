/** Independent Horizon transaction-result XDR gate. This is evidence only.
 * NEVER creates a certificate, approval, or wallet rotation.
 * The successful Horizon flag alone is not proof of operation success.
 */
import { xdr } from '@stellar/stellar-sdk'

export type R36ResultXdrEvidence = Readonly<{
  outcome: 'VALID_RESULT' | 'BLOCKED'
  reason: string
  authorizesRotation: false
}>
const deny = (reason: string): R36ResultXdrEvidence => ({outcome:'BLOCKED',reason,authorizesRotation:false})
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function verifyR36TransactionResultXdr(
  encoded: unknown, expectedFeeStroops: string, expectedOperations = 1,
): R36ResultXdrEvidence {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 65536 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0 ||
      !/^(0|[1-9]\d*)$/.test(expectedFeeStroops) ||
      !Number.isSafeInteger(expectedOperations) || expectedOperations !== 1)
    return deny('INVALID_RESULT_INPUT')
  try {
    const parsed = xdr.TransactionResult.fromXDR(encoded, 'base64')
    // Exact round-trip blocks noncanonical encodings and trailing data.
    if (parsed.toXDR('base64') !== encoded) return deny('NONCANONICAL_RESULT_XDR')
    if (parsed.feeCharged.toString() !== expectedFeeStroops)
      return deny('RESULT_FEE_MISMATCH')
    // SDK 17 XDR uses discriminated *objects*, not switch()/results() methods.
    // Never accept fee-bump, txFailed, or a result with unknown shape.
    const result: unknown = parsed.result
    if (!isRecord(result) || result.type !== 'txSuccess') return deny('RESULT_NOT_SUCCESS')
    const operations: unknown = result.results
    if (!Array.isArray(operations) || operations.length !== expectedOperations)
      return deny('RESULT_OPERATION_COUNT_MISMATCH')
    // One successful native payment operation is the only supported intent.
    for (const operation of operations) {
      if (!isRecord(operation) || operation.type !== 'opInner' ||
          !isRecord(operation.tr) || operation.tr.type !== 'payment' ||
          !isRecord(operation.tr.paymentResult) ||
          operation.tr.paymentResult.type !== 'paymentSuccess')
        return deny('RESULT_OPERATION_NOT_SUCCESSFUL_PAYMENT')
    }
    return {outcome:'VALID_RESULT',reason:'SUCCESSFUL_TRANSACTION_RESULT_XDR',authorizesRotation:false}
  } catch { return deny('INVALID_RESULT_XDR') }
}
