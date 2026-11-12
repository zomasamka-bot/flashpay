import "server-only"

// Read-only, same-statement snapshot. $1 is a merchant id, or NULL for health.
// Legacy accounting remains visible; its absence of a checkpoint is not network certification.
export const financialPresentationIntegrityCTE = `presentation_integrity AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM receipts r LEFT JOIN transactions t ON t.id=r.transaction_id
    LEFT JOIN settlement_checkpoints s ON s.u2a_identifier=t.payment_id
    WHERE ($1::text IS NULL OR r.merchant_id=$1 OR t.merchant_id=$1)
      AND r.settlement_status='settled_to_merchant' AND (
        t.id IS NULL OR r.merchant_id IS DISTINCT FROM t.merchant_id
        OR r.merchant_uid IS DISTINCT FROM t.merchant_uid OR r.amount IS DISTINCT FROM t.amount
        OR r.customer_amount IS DISTINCT FROM (t.amount+r.app_commission) OR r.merchant_amount IS DISTINCT FROM t.amount
        OR r.app_commission IS NULL OR r.app_commission<0 OR (s.payment_id IS NULL AND r.app_commission<>0) OR r.horizon_fee_charged IS NULL
        OR r.horizon_fee_charged < 0 OR r.app_net_impact IS DISTINCT FROM (r.app_commission-r.horizon_fee_charged)
        OR (s.payment_id IS NOT NULL AND (
          s.stage <> 'db_finalized' OR s.merchant_id IS DISTINCT FROM t.merchant_id
          OR s.merchant_uid IS DISTINCT FROM t.merchant_uid OR s.customer_amount IS DISTINCT FROM r.customer_amount OR s.merchant_amount IS DISTINCT FROM t.amount OR s.app_commission IS DISTINCT FROM r.app_commission
          OR s.u2a_identifier IS DISTINCT FROM r.u2a_identifier OR s.u2a_txid IS DISTINCT FROM r.u2a_txid
          OR s.a2u_payment_id IS DISTINCT FROM r.a2u_identifier OR s.a2u_txid IS DISTINCT FROM r.a2u_txid
          OR s.prepared_tx_hash IS DISTINCT FROM r.txid
          OR s.horizon_fee_stroops::numeric / 10000000 IS DISTINCT FROM r.horizon_fee_charged
        ))
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM settlement_checkpoints s
    WHERE ($1::text IS NULL OR s.merchant_id=$1) AND s.stage='db_finalized' AND (
      (SELECT count(*) FROM transactions t JOIN receipts r ON r.transaction_id=t.id
       WHERE t.payment_id=s.u2a_identifier AND r.settlement_status='settled_to_merchant') <> 1
      OR EXISTS (SELECT 1 FROM refund_checkpoints f WHERE f.payment_id=s.payment_id
        AND (f.status IN ('pending','manual_review_required','completed') OR f.refund_txid IS NOT NULL))
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM receipts
    ) m LEFT JOIN merchant_balances b ON b.merchant_id=m.merchant_id
    WHERE ($1::text IS NULL OR m.merchant_id=$1)
      AND COALESCE(b.settled,0) IS DISTINCT FROM
        (SELECT COALESCE(sum(r.merchant_amount),0) FROM receipts r
         WHERE r.merchant_id=m.merchant_id AND r.settlement_status='settled_to_merchant')
  ) AS valid
)`
