-- Phase 3 (scale audit) P-RD-006 / P-RD-003 / P-RD-001 (index half): hot-path
-- indexes that keep dashboards and invoice lists fast as booking/invoice volume
-- grows. The bookings FK indexes (slot_id, player_id, status) already exist;
-- these add the missing time/filter composites. Built now while volume is low
-- (a plain CREATE INDEX is cheap today; deferring means a painful build later).

-- Dashboard "recent bookings" sorts the per-academy/per-trainer set by created_at
-- and LIMITs — without this, Postgres materializes + sorts the full lifetime set
-- on every dashboard open.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at
  ON public.bookings (created_at DESC);

-- Invoice lists filter by owner + status and sort by created_at (the paginated
-- get_*_invoices RPCs + the "outstanding invoices" tiles). One composite covers
-- the owner filter, the status filter, and the recency sort.
CREATE INDEX IF NOT EXISTS idx_invoices_academy_status_created
  ON public.invoices (academy_profile_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_trainer_status_created
  ON public.invoices (trainer_id, status, created_at DESC);
