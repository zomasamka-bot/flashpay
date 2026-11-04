BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL search_path=pg_catalog,pg_temp;
LOCK TABLE public.r36_recovery_trial_reservations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.r36_recovery_trial_reservations) THEN
 RAISE EXCEPTION 'PRESERVE_TESTNET_BUDGET_HISTORY'; END IF; END $$;
DROP FUNCTION public.r36_reserve_new_recovery(text,text);
DROP TABLE public.r36_recovery_trial_reservations;
REVOKE SELECT (payment_id,merchant_id,merchant_uid,customer_amount,created_at) ON public.payment_create_intents FROM r36_owner;
COMMIT;
