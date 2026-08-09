-- U1c PREREQUISITE 4 — a deliberately privileged export path for the nightly backup.
--
-- THE PROBLEM. `academy_player_memberships`, `membership_backfill_runs` and
-- `membership_backfill_items` are the only things a U1c backfill rollback can be reconstructed from,
-- and all three `REVOKE ALL ... FROM service_role` — deliberately, because they are inert and
-- owner-only until the backfill is authorized. The nightly backup runs as `service_role`, and
-- BYPASSRLS does not bypass table privileges. So adding them to the backup's table list makes every
-- nightly run fail with permission denied.
--
-- Granting `service_role` SELECT on them would fix the backup by widening what all forty-odd
-- service-role edge functions can read — paying for one caller with a privilege for every caller.
-- Instead there is ONE function, owned by the definer, allow-listed to exactly the tables the backup
-- exports, granted to `service_role` alone, and read-only by construction (it returns `SETOF jsonb`
-- and contains no writing statement).
--
-- The backup routes EVERY table through it, not just the closed ones. A two-path backup — PostgREST
-- for open tables, RPC for closed ones — is two paging implementations, two failure modes, and one
-- of them exercised only by the tables nobody looks at.
--
-- SECURITY. SECURITY DEFINER with `search_path = pg_catalog, public, pg_temp`: pg_catalog first so a
-- built-in cannot be shadowed, pg_temp last so a temporary object can never win resolution. The
-- relation name is validated against a pinned allow-list before it reaches dynamic SQL, and is then
-- passed through `quote_ident` regardless — an allow-list is the guard, quoting is the belt.

-- The tables the export may read. This is the SOURCE OF TRUTH for backup coverage:
-- `scripts/db/backup-coverage.mjs` asserts it agrees with the edge function's TABLES_TO_BACKUP and
-- covers the derived identity family, so the list here and the list there cannot drift apart.
CREATE OR REPLACE FUNCTION public.backup_export_tables()
RETURNS TABLE (relname text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM (VALUES
    ('academy_managers'), ('academy_player_locations'), ('academy_player_memberships'),
    ('academy_player_metadata'), ('academy_player_tags'), ('academy_profiles'),
    ('academy_trainers'), ('availability_slots'), ('bookings'), ('club_managers'),
    ('club_profiles'), ('guest_players'), ('intake_requests'), ('invoices'),
    ('locations'), ('membership_backfill_items'), ('membership_backfill_runs'),
    ('notification_contacts'), ('person_links'), ('person_merge_review'), ('persons'),
    ('profiles'), ('proposed_assignments'), ('session_player_notes'),
    ('slot_priority_claims'), ('trainer_profiles'), ('user_roles')
  ) AS t(relname);
$$;

-- How many rows the table holds, for the completeness check the backup makes against its page walk.
CREATE OR REPLACE FUNCTION public.backup_export_count(_relname text)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.backup_export_tables() t WHERE t.relname = _relname) THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an exportable relation', _relname
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  EXECUTE format('SELECT count(*) FROM public.%I', _relname) INTO v_n;
  RETURN v_n;
END;
$$;

-- One page of a table, keyset-walked on its `id` primary key.
--
-- Ordered and bounded HERE rather than by the caller: PostgREST guarantees no row order without an
-- explicit sort, and a keyset walk over unordered pages skips rows silently. `_after IS NULL` starts
-- the walk; `id > _after` continues it. The single-column uuid `id` this depends on is asserted for
-- every listed table by `scripts/db/backup-coverage.mjs`.
CREATE OR REPLACE FUNCTION public.backup_export_page(_relname text, _after uuid, _limit int)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.backup_export_tables() t WHERE t.relname = _relname) THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an exportable relation', _relname
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _limit IS NULL OR _limit < 1 OR _limit > 5000 THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_BAD_LIMIT: % is not a usable page size', _limit
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT to_jsonb(t) FROM public.%I t WHERE ($1 IS NULL OR t.id > $1) ORDER BY t.id LIMIT $2',
    _relname
  ) USING _after, _limit;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_export_tables() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_count(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_page(text, uuid, int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backup_export_tables() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_count(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_page(text, uuid, int) TO service_role;

COMMENT ON FUNCTION public.backup_export_page(text, uuid, int) IS
  'Read-only keyset page of an allow-listed table, for the nightly backup. SECURITY DEFINER so the backup can read membership tables that revoke service_role, without granting every service-role caller SELECT on them. Ordering lives here because PostgREST guarantees none.';
