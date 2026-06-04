-- P0 PR-1..PR-4 manual verification (run against staging / ficwb with appropriate role)
-- Deploy notes + known edge case: docs/P0_PR1_PR4_NOTES.md
-- Replace placeholders before running destructive checks.

-- =============================================================================
-- PR-2: Player invoice UPDATE guard (trigger trg_protect_invoice_financial_columns_for_players)
-- =============================================================================
-- Preconditions: pick a sent invoice owned by a test player profile you control.
-- \set invoice_id '...'
-- \set player_profile_id '...'

-- As authenticated player (via client or SET ROLE), billing update should succeed:
-- UPDATE invoices SET player_business_name = 'Test BV' WHERE id = :'invoice_id';

-- Financial tamper must fail with players_may_only_update_billing_fields:
-- UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = :'invoice_id';

-- Paid invoice billing lock:
-- UPDATE invoices SET player_address = 'x' WHERE id = :'invoice_id' AND status = 'paid';
-- Expected: invoice_locked

-- =============================================================================
-- PR-1 / PR-3 / PR-4: Edge functions (curl examples — run from shell, not SQL)
-- =============================================================================
-- backup-database: Bearer anon key -> 401; service role or admin JWT -> 200
-- create-invoice-payment: body without publicToken -> 400; wrong token -> 404
-- get-booking-invoice: no Authorization -> 401; other user's bookingId -> 403

SELECT EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgname = 'trg_protect_invoice_financial_columns_for_players'
) AS pr2_trigger_installed;

SELECT proname FROM pg_proc
WHERE proname = 'protect_invoice_financial_columns_for_players';
