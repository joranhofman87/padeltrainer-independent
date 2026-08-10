-- U1c PREREQUISITE 4 — a deliberately privileged, internally consistent export for the backup.
--
-- THE PROBLEM. `academy_player_memberships`, `membership_backfill_runs` and
-- `membership_backfill_items` are the only things a U1c backfill rollback can be reconstructed from,
-- and all three `REVOKE ALL ... FROM service_role` — deliberately, because they are inert and
-- owner-only until the backfill is authorized. The nightly backup runs as `service_role`, and
-- BYPASSRLS does not bypass table privileges, so simply adding them to the backup's list makes every
-- nightly run fail with permission denied.
--
-- WHY ONE STATEMENT. The first version of this paged: count, then walk. Counting in one request and
-- reading pages in later ones cannot produce a consistent export — a row deleted behind the cursor
-- and another inserted ahead of it leaves the count matching while the export represents no instant
-- that ever existed. Retrying does not fix that; it only hides the cases where the count happens to
-- disagree. So an export is ONE statement, which sees ONE snapshot.
--
-- WHY GROUPS, NOT TABLES. Per-table consistency is not enough for the thing this exists for. The
-- U1c rollback record spans three tables: a `membership_backfill_items` row names a run and a
-- membership, and if a backfill commits between two separate exports the backup contains an item
-- whose membership is missing, or a membership with no provenance. Neither is a rollback anchor. So
-- tables that must agree with each other are exported together, in one call, and the function is
-- STABLE — which is precisely what makes every query inside it use the CALLING STATEMENT's snapshot
-- rather than taking a fresh one per query. Marking it VOLATILE would silently reintroduce the split.
--
-- Groups are declared, not inferred: `backup_export_groups()` puts the membership family in one
-- group and everything else in a group of its own, so the memory cost of aggregating several tables
-- at once is paid only where cross-table agreement is actually required.
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

-- Which tables must be exported TOGETHER because they have to agree with each other. Anything not
-- named here is its own group, so this list stays as short as the requirement.
CREATE OR REPLACE FUNCTION public.backup_export_groups()
RETURNS TABLE (group_name text, relname text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- the U1c rollback record: an item names a run and a membership, so all three or none
  SELECT 'u1c_membership', r FROM unnest(ARRAY[
    'academy_player_memberships', 'membership_backfill_runs', 'membership_backfill_items'
  ]) r
  UNION ALL
  SELECT t.relname, t.relname
    FROM public.backup_export_tables() t
   WHERE t.relname NOT IN ('academy_player_memberships', 'membership_backfill_runs',
                           'membership_backfill_items');
$$;

/**
 * Bounds above which an export is refused rather than attempted.
 *
 * A group becomes one jsonb value, and jsonb tops out around 1GB — but long before that the honest
 * answer is that a JSON-blob backup is the wrong mechanism and the export should move to pg_dump or
 * a streaming path. Refusing loudly at a known bound beats discovering it as an out-of-memory in the
 * middle of the night, which looks like an outage rather than a design limit.
 *
 * TWO bounds, because a row count says nothing about size: these tables carry unbounded `text` and
 * `jsonb`, so a hundred rows can outweigh a million. The byte bound reads on-disk size, which is an
 * estimate — TOAST compression means it can under-read a JSON expansion — so the row bound stays as
 * the cheap second opinion. Neither is a guarantee; both are refusals with a sentence attached.
 */
CREATE OR REPLACE FUNCTION public.backup_export_max_rows()
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT 500000::bigint $$;

CREATE OR REPLACE FUNCTION public.backup_export_max_bytes()
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT (256 * 1024 * 1024)::bigint $$;

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
  v_bytes bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.backup_export_tables() t WHERE t.relname = _relname) THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an exportable relation', _relname
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Checked before the aggregate, and BYTES FIRST: the byte bound is the one that can actually
  -- predict the aggregate, and `count(*)` on a table too large to export is itself a scan nobody
  -- needs. The row count stays as the cheap second opinion.
  v_bytes := pg_table_size(to_regclass('public.' || quote_ident(_relname)));
  IF v_bytes > public.backup_export_max_bytes() THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_TOO_LARGE: % holds % bytes, above the % this export can hold in one value',
      _relname, v_bytes, public.backup_export_max_bytes()
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

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

-- A whole group, from ONE statement — so every table in it agrees with every other.
--
-- STABLE is load-bearing here, not decoration: in READ COMMITTED a VOLATILE function takes a fresh
-- snapshot for each query it runs, which would put the tables back on different snapshots and
-- recreate exactly the split this exists to close.
CREATE OR REPLACE FUNCTION public.backup_export_group(_group text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rel text;
  v_out jsonb := '{}'::jsonb;
  v_any boolean := false;
  v_bytes bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.backup_export_groups() g WHERE g.group_name = _group) THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an export group', _group
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The bound belongs HERE as well as per table: a group is ONE jsonb value, so three tables that
  -- each pass the per-table bound can still exceed it together. Checked before any aggregation, so
  -- the refusal arrives instead of the memory pressure.
  SELECT coalesce(sum(pg_table_size(to_regclass('public.' || quote_ident(g.relname)))), 0)
    INTO v_bytes
    FROM public.backup_export_groups() g
   WHERE g.group_name = _group;

  IF v_bytes > public.backup_export_max_bytes() THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_TOO_LARGE: group % holds % bytes, above the % this export can hold in one value',
      _group, v_bytes, public.backup_export_max_bytes()
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  FOR v_rel IN
    SELECT g.relname FROM public.backup_export_groups() g WHERE g.group_name = _group ORDER BY 1
  LOOP
    v_any := true;
    v_out := v_out || jsonb_build_object(v_rel, public.backup_export_table(v_rel));
  END LOOP;

  IF NOT v_any THEN
    RAISE EXCEPTION 'BACKUP_EXPORT_NOT_ALLOWED: % is not an export group', _group
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.backup_export_tables() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_groups() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_max_rows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_max_bytes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_group(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backup_export_table(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.backup_export_tables() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_groups() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_max_rows() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_max_bytes() TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_group(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.backup_export_table(text) TO service_role;

COMMENT ON FUNCTION public.backup_export_table(text) IS
  'Read-only export of one allow-listed table as {row_count, rows}, from a single scan so the two cannot disagree. SECURITY DEFINER so the nightly backup can read the membership tables that revoke service_role. NOTE: EXECUTE is granted to the shared service_role, so any service-role caller can read those tables through this function — a dedicated backup principal is the alternative, and an owner decision.';
