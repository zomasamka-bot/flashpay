-- FIN-100B read-only diagnostic: records are evidence of event timing, not necessarily original payment creation.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '12s';
SET LOCAL lock_timeout = '2s';
WITH facts AS (
 SELECT c.payment_id, c.stage, c.created_at AS checkpoint_at,
        i.created_at AS intent_at,
        t.created_at AS settlement_transaction_at,
        r.created_at AS receipt_recorded_at,
        r.timestamp AS receipt_timestamp,
        c.u2a_verified_at, c.u2a_completed_at,
        c.db_finalized_at,
        i.payment_id IS NOT NULL AS has_intent,
        t.id IS NOT NULL AS has_transaction,
        r.id IS NOT NULL AS has_receipt,
        r.metadata AS receipt_metadata
 FROM settlement_checkpoints c
 LEFT JOIN payment_create_intents i ON i.payment_id = c.payment_id
 LEFT JOIN transactions t ON t.payment_id = c.u2a_identifier
 LEFT JOIN receipts r ON r.transaction_id = t.id
)
SELECT stage,
 count(*) AS checkpoints,
 count(*) FILTER(WHERE NOT has_intent) AS legacy,
 count(*) FILTER(WHERE has_transaction) AS with_settlement_transaction,
 count(*) FILTER(WHERE has_receipt) AS with_receipt,
 count(*) FILTER(WHERE has_intent AND intent_at = checkpoint_at) AS intent_checkpoint_same_instant,
 count(*) FILTER(WHERE has_intent AND intent_at <> checkpoint_at) AS intent_checkpoint_different_instant,
 count(*) FILTER(WHERE NOT has_intent AND has_transaction AND settlement_transaction_at < checkpoint_at) AS transaction_predates_checkpoint,
 count(*) FILTER(WHERE NOT has_intent AND has_receipt AND receipt_recorded_at < checkpoint_at) AS receipt_predates_checkpoint,
 count(*) FILTER(WHERE NOT has_intent AND has_receipt AND receipt_metadata ? 'createdAt') AS receipt_metadata_has_created_at,
 count(*) FILTER(WHERE checkpoint_at IS NULL OR checkpoint_at = timestamp '1970-01-01') AS invalid_checkpoint_time
FROM facts GROUP BY stage ORDER BY stage;
COMMIT;
