/** Read-only navigation recovery, never payment or wallet authority.
 * The caller must first authenticate payerUid with Pi. Reopening the original
 * page still requires its original admission, start lease and approval guards.
 */
export const paymentStartResumeSQL = `
SELECT prior.payment_id
FROM public.r36_payment_intake requested
JOIN public.r36_payment_intake prior
  ON prior.policy_digest=requested.policy_digest
 AND prior.source_wallet=requested.source_wallet
 AND prior.merchant_uid=requested.merchant_uid
 AND prior.merchant_id=requested.merchant_id
 AND prior.amount_stroops=requested.amount_stroops
 AND prior.note_digest=requested.note_digest
 AND prior.wallet_contract=requested.wallet_contract
 AND prior.payment_id<>requested.payment_id
 AND prior.created_at<=requested.created_at
JOIN public.r36_testnet_ingress_reservations slot
  ON slot.payment_id=prior.payment_id AND slot.policy_digest=prior.policy_digest
 AND slot.retired_by_payment_id IS NULL
JOIN public.settlement_checkpoints original ON original.payment_id=prior.payment_id
JOIN public.settlement_checkpoints current ON current.payment_id=requested.payment_id
WHERE requested.payment_id=$1 AND requested.policy_digest=$3
 AND prior.payer_uid=$2 AND (requested.payer_uid IS NULL OR requested.payer_uid=$2)
 AND requested.wallet_contract='PI_PAYMENT_DTO_V1'
 AND original.stage='payment_identity' AND current.stage='payment_identity'
 AND original.merchant_uid=prior.merchant_uid AND current.merchant_uid=requested.merchant_uid
 AND original.merchant_id=prior.merchant_id AND current.merchant_id=requested.merchant_id
 AND original.customer_amount*10000000=prior.amount_stroops
 AND current.customer_amount*10000000=requested.amount_stroops
 AND original.merchant_amount=current.merchant_amount
 AND original.app_commission=current.app_commission
 AND original.customer_amount=original.merchant_amount+original.app_commission
 AND current.customer_amount=current.merchant_amount+current.app_commission
 AND ((original.financial_contract IS NULL AND current.financial_contract IS NULL AND original.app_commission=0)
   OR (jsonb_typeof(original.financial_contract)='object' AND jsonb_typeof(current.financial_contract)='object'
     AND original.financial_contract->>'paymentId'=prior.payment_id
     AND current.financial_contract->>'paymentId'=requested.payment_id
     AND original.financial_contract->>'merchantUid'=prior.merchant_uid
     AND current.financial_contract->>'merchantUid'=requested.merchant_uid
     AND original.financial_contract-'paymentId'=current.financial_contract-'paymentId'))
 AND ((original.u2a_approval_identifier IS NULL AND original.u2a_approval_claimed_at IS NULL)
   OR (original.u2a_approval_identifier IS NOT NULL AND original.u2a_approval_claimed_at IS NOT NULL))
 AND current.u2a_approval_identifier IS NULL AND current.u2a_approval_claimed_at IS NULL
 AND original.u2a_identifier IS NULL AND current.u2a_identifier IS NULL
 AND original.u2a_txid IS NULL AND current.u2a_txid IS NULL
 AND original.u2a_completed_at IS NULL AND current.u2a_completed_at IS NULL
 AND original.a2u_payment_id IS NULL AND current.a2u_payment_id IS NULL
 AND original.prepared_tx_hash IS NULL AND current.prepared_tx_hash IS NULL
 AND NOT EXISTS (SELECT 1 FROM public.r36_testnet_ingress_reservations r WHERE r.payment_id=requested.payment_id)
 AND NOT EXISTS (SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id IN (prior.payment_id,requested.payment_id))
LIMIT 2`

export async function findResumablePaymentStart(
  read: (sql: string, values: unknown[]) => Promise<unknown>,
  paymentId: string, payerUid: string, policy: string,
): Promise<string | null> {
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  if (!id.test(paymentId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(payerUid) || !/^[0-9a-f]{64}$/.test(policy)) return null
  try {
    const rows = await read(paymentStartResumeSQL, [paymentId, payerUid, policy])
    if (!Array.isArray(rows) || rows.length !== 1) return null
    const original = rows[0]?.payment_id
    return typeof original === 'string' && id.test(original) && original !== paymentId ? original : null
  } catch { return null }
}
