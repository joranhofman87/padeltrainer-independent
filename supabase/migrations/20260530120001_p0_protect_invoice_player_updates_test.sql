-- PR-2: assert trigger is installed (no data mutation)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_protect_invoice_financial_columns_for_players'
  ) THEN
    RAISE EXCEPTION 'PR-2 trigger trg_protect_invoice_financial_columns_for_players missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'protect_invoice_financial_columns_for_players'
  ) THEN
    RAISE EXCEPTION 'PR-2 function protect_invoice_financial_columns_for_players missing';
  END IF;
END $$;
