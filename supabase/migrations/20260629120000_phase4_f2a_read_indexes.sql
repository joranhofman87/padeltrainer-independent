-- Phase 4 F2a — scalability READ foundation (set-based, owner-deployed, INERT until consumed).
--
-- (1) Indexes the F2 RPCs + hot reads rely on at 10k+ slots. All IF NOT EXISTS + idempotent.
-- (2) count_cycles_intakes — replaces the unbounded `SELECT cycle_id FROM intake_requests` client
--     scan in getCyclesWithCounts / listRegistrationCycles with one GROUP BY. SECURITY INVOKER so
--     RLS still scopes the rows to the caller. Nothing calls it yet (a consuming slice wires it with
--     a graceful fallback so it is safe pre-deploy).

-- ---- indexes -----------------------------------------------------------------------------------

-- Delete-guard hot path: "does this slot have an active (capacity-occupying) booking?" (F2b delete).
-- Partial index keyed on slot_id, only the occupying statuses → tiny + exactly matches the predicate.
CREATE INDEX IF NOT EXISTS idx_bookings_slot_status
  ON public.bookings (slot_id)
  WHERE status IN ('confirmed', 'pending', 'pending_approval');

-- Cyclus-group aggregation (get_cyclus_groups_paginated) groups by (cyclus_id, trainer_id).
CREATE INDEX IF NOT EXISTS idx_availability_slots_cyclus_trainer
  ON public.availability_slots (cyclus_id, trainer_id);

-- (idx_intake_requests_cycle on intake_requests(cycle_id) already exists — count_cycles_intakes uses it.)

-- ---- count_cycles_intakes ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.count_cycles_intakes(_cycle_ids uuid[])
RETURNS TABLE(cycle_id uuid, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT ir.cycle_id, count(*)::bigint AS n
  FROM public.intake_requests ir
  WHERE ir.cycle_id = ANY(_cycle_ids)
  GROUP BY ir.cycle_id;
$$;

COMMENT ON FUNCTION public.count_cycles_intakes(uuid[]) IS
  'Phase 4 F2a: per-cycle intake counts in one GROUP BY (replaces the unbounded client scan). RLS-scoped (SECURITY INVOKER).';
