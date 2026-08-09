-- U1c PREREQUISITE 4 — a deliberately privileged, internally consistent export for the backup.
--
-- THE PROBLEM. `academy_player_memberships`, `membership_backfill_runs` and
-- `membership_backfill_items` are the only things a U1c backfill rollback can be reconstructed from,
-- and all three `REVOKE ALL ... FROM service_role` — deliberately, because they are inert and
-- owner-only until the backfill is authorized. The nightly backup runs as `service_role`, and
-- BYPASSRLS does not bypass table privileges, so simply adding them to the backup's list makes every
-- nightly run fail with permission denied.
--
-- WHY ONE STATEMENT PER TABLE. The first version of this paged: count, then walk. Counting in one
-- request and reading pages in later ones cannot produce a consistent export — a row deleted behind
-- the cursor and another inserted ahead of it leaves the count matching while the export represents
-- no instant that ever existed. Retrying does not fix that; it only hides the cases where the count
-- happens to disagree. So a table is read by ONE statement, which sees ONE snapshot, and that
-- statement returns the rows AND their count together. They cannot disagree, because they are the
-- same scan. (Cross-TABLE consistency is still not provided — that would need an exported snapshot
-- held across the whole run, which PostgREST has no way to express. Recorded, not pretended.)
--
-- The paging it replaces existed to dodge PostgREST's `max_rows` cap. A function returning a single
-- `jsonb` returns one row, so the cap has nothing to truncate; and the backup already materialised
-- every table in memory to JSON-encode it, so this is not new memory pressure.
--
-- WHO MAY CALL IT. `service_role`, which is the same principal every other edge function uses. This
-- is a real widening: any service-role caller can now read the membership tables through this
-- function, where before none could read them at all. It is the price of having them in the nightly
-- backup, and the alternative — a dedicated database principal with its own credential for the
-- backup worker — is a deployment change and an owner decision. Written down rather than implied.
--
-- SECURITY. SECURITY DEFINER with `search_path = pg_catalog, public, pg_temp`: pg_catalog first so a
-- built-in cannot be shadowed, pg_temp last so a temporary object can never win resolution. The
-- relation name is checked against a pinned allow-list BEFORE it reaches dynamic SQL, and is passed
-- through `quote_ident` regardless — the allow-list is the guard, the quoting is the belt.

-- The tables the export may read. This is the SOURCE OF TRUTH for backup coverage:
-- `scripts/db/backup-coverage.mjs` asserts it agrees with the edge function's TABLES_TO_BACKUP in
-- both directions, so the list here and the list there cannot drift apart.
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

/**
 * Above this many rows the aggregate is refused rather than attempted.
 *
 * A whole table becomes one jsonb value, and jsonb tops out around 1GB — but long before that the
 * honest answer is that a JSON-blob backup is the wrong mechanism and the export should move to
 * pg_dump or a streaming path. Refusing loudly at a known bound beats discovering it as an
 * out-of-memory in the middle of the night, which looks like an outage rather than a design limit.
 */
CREATE OR REPLACE FUNCTION public.backup_export_max_rows()
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT 500000::bigint $$;

-- One table, one snapshot, rows and count from the same scan.
CREATE OR REPLACE FUNCTION public.backup_export_table(_relname text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_out jsonb;
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.backup_export_tables() t WHERE t.relname = _relname) THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an exportable relation', _relname
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Checked first and separately: the bound exists to avoid attempting an aggregate that cannot
  -- succeed, so it has to be answered before the aggregate is attempted.
  EXECUTE format('SELECT count(*) FROM public.%I', _relname) INTO v_n;
  IF v_n > public.backup_export_max_rows() THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_TOO_LARGE: % has % rows, above the % this export can hold in one value',
      _relname, v_n, public.backup_export_max_rows()
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  -- ORDER BY id: not needed for correctness now that there is no cursor, but it makes two exports of
  -- an unchanged table byte-identical, which is what lets anyone diff them.
  EXECUTE format(
    'SELECT jsonb_build_object(
        ''row_count'', count(*),
        ''rows'', coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), ''[]''::jsonb))
       FROM public.%I t', _relname
  ) INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_export_tables() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_max_rows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_table(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backup_export_tables() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_max_rows() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_table(text) TO service_role;

COMMENT ON FUNCTION public.backup_export_table(text) IS
  'Read-only export of one allow-listed table as {row_count, rows}, from a single scan so the two cannot disagree. SECURITY DEFINER so the nightly backup can read the membership tables that revoke service_role. NOTE: EXECUTE is granted to the shared service_role, so any service-role caller can read those tables through this function — a dedicated backup principal is the alternative, and an owner decision.';
