-- U1a ROLLBACK — remove the empty additive membership skeleton.
--
-- Forward rollback for `supabase/migrations/20261113100000_u1a_academy_player_memberships.sql`.
-- U1a ships an EMPTY table that nothing reads or writes, so removing it is safe *while it is still
-- empty*. Once a later unit populates it, dropping the table destroys academy-private relationship
-- evidence — which OD-10 forbids. Hence the emptiness guard: this script REFUSES rather than
-- deletes.
--
-- Deliberately NOT `DROP ... CASCADE`: cascade would silently remove dependent objects created by
-- some later slice, which is exactly the "silent destruction" this programme rules out. If a
-- dependency exists, the drop must fail loudly so a human decides.
--
-- The parents (`academy_profiles`, `persons`) and the SHARED `public.update_updated_at_column()`
-- function must survive: the function is used by many other tables, and dropping the trigger happens
-- implicitly with the table.
--
-- The seed deny-list entry in `supabase/seed.sql` needs no change — it is existence-guarded
-- (`to_regclass`), so a reset after this rollback succeeds with the table absent.
--
-- After running this: regenerate `src/integrations/supabase/types.ts` so the types-drift gate matches
-- the rolled-back schema.

DO $$
DECLARE
  v_rows bigint;
BEGIN
  IF to_regclass('public.academy_player_memberships') IS NULL THEN
    RAISE NOTICE 'academy_player_memberships is already absent — nothing to roll back.';
    RETURN;
  END IF;

  -- Take the lock BEFORE counting and hold it through the DROP (a DO block is one transaction).
  -- Without it the guard is a TOCTOU: a concurrent INSERT could commit between `count(*)` and the
  -- DROP's own lock acquisition, and the drop would destroy membership evidence the count never saw.
  -- ACCESS EXCLUSIVE is what DROP TABLE takes anyway, so this only moves the wait earlier.
  LOCK TABLE public.academy_player_memberships IN ACCESS EXCLUSIVE MODE;

  EXECUTE 'SELECT count(*) FROM public.academy_player_memberships' INTO v_rows;

  IF v_rows <> 0 THEN
    RAISE EXCEPTION
      'REFUSING to roll back U1a: academy_player_memberships holds % row(s). Dropping it would destroy academy-private membership evidence (OD-10). Resolve the population unit first.',
      v_rows
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE 'DROP TABLE public.academy_player_memberships';
  RAISE NOTICE 'U1a rolled back: academy_player_memberships dropped (was empty).';
END $$;

-- Post-conditions a rehearsal asserts:
--   * public.academy_player_memberships       → absent
--   * public.academy_profiles / public.persons → still present
--   * public.update_updated_at_column()        → still present (shared by other tables)
