ALTER TABLE public.settlement_checkpoints ADD COLUMN IF NOT EXISTS financial_contract jsonb;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_app_commission_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_financial_contract_check;
ALTER TABLE public.settlement_checkpoints ADD CONSTRAINT settlement_financial_contract_check CHECK (public.r36_contract_valid(jsonb_build_object(
 'payment_id',payment_id,'merchant_uid',merchant_uid,'customer_amount',customer_amount,'merchant_amount',merchant_amount,'app_commission',app_commission,'financial_contract',financial_contract)));
DROP TRIGGER IF EXISTS financial_contract_snapshot ON public.settlement_checkpoints;
CREATE TRIGGER financial_contract_snapshot BEFORE INSERT OR UPDATE ON public.settlement_checkpoints FOR EACH ROW EXECUTE FUNCTION public.r36_contract_snapshot_guard();
GRANT SELECT(financial_contract) ON public.settlement_checkpoints TO r36_evidence_reader;
