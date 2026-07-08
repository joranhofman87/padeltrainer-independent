-- ============================================================================
-- REBOOK · don't expire a paid group's held teammate seats (roster-after-pay guard)
-- ============================================================================
-- In the group-captain upfront model, the captain pays the FULL court price and is booked
-- ('claimed'); the teammates' claims stay 'pending' so their seats are HELD until the captain
-- assigns them in the post-payment roster step. But expire_lapsed_priority_claims() expired ANY
-- pending claim once the priority window closed — so a captain who paid but rostered late (after
-- the window) silently lost the teammate seats they had already paid the court for.
--
-- Guard: skip pending claims whose rebook_group_id already has a 'claimed' member (a captain
-- accepted/paid for the whole court). Those held seats stay until the captain rosters. Ungrouped
-- claims (rebook_group_id NULL) and groups with no claimed member expire exactly as before.
-- Re-emitted verbatim from 20260704200000 with only the NOT EXISTS guard added.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.expire_lapsed_priority_claims()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH lapsed AS (
    UPDATE public.slot_priority_claims c
      SET status = 'expired',
          responded_at = COALESCE(c.responded_at, now())
    FROM public.availability_slots s
    WHERE c.slot_id = s.id
      AND c.status = 'pending'
      AND s.priority_window_ends_at IS NOT NULL
      AND s.priority_window_ends_at < now()
      -- roster-after-pay guard: keep a held seat whose group already has a claimed captain.
      AND NOT EXISTS (
        SELECT 1 FROM public.slot_priority_claims g
        WHERE g.rebook_group_id = c.rebook_group_id
          AND g.status = 'claimed'
      )
    RETURNING c.id
  )
  SELECT count(*) INTO v_count FROM lapsed;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_lapsed_priority_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_lapsed_priority_claims() TO service_role;
