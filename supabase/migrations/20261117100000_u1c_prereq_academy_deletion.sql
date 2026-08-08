-- U1c PREREQUISITE 3 — audited, transactional academy deletion.
--
-- WHAT IS WRONG TODAY. `src/pages/admin/AdminAcademies.tsx` deletes an academy with EIGHT separately
-- committed statements — managers, locations, trainers, invitations, views, followers, Mollie
-- accounts, then the profile. There is no transaction, and the LAST statement is the one that can
-- refuse: `invoices` references `academy_profiles` with NO ACTION, so an academy with a single
-- invoice fails at the end, after seven commits, leaving it alive with its payment credentials and
-- trainer links destroyed.
--
-- Three more hazards ride along:
--   * `guest_players` cascades, and deleting a guest can delete its person — potentially identity
--     shared with ANOTHER academy;
--   * `academy_player_metadata` has NO foreign key to academy_profiles at all, and
--     `academy_player_locations.academy_profile_id` points at `profiles` (the wrong-target FK U1a
--     documented), so neither cascades and both leave orphans;
--   * the only database guard checks cycles/registrations.
--
-- THE SHAPE OF THE FIX. One preview, one confirmation, one transaction. Every refusal is a
-- RAISE EXCEPTION, so the transaction rolls back and NOTHING is deleted — partial deletion becomes
-- structurally impossible rather than merely unlikely.
--
-- The confirmation carries a DIGEST of the state the operator was shown. It is revision-sensitive:
-- it covers each row's primary key AND its `xmin`, so editing an existing row invalidates it even
-- though no id and no count changed. Identities and revisions exist only inside the hash input; the
-- payloads the UI and the audit see carry counts, codes and the digest.
--
-- SECURITY. Every function here is SECURITY DEFINER with `search_path = pg_catalog, public, pg_temp`:
-- pg_catalog first so a built-in cannot be shadowed, pg_temp LAST so a temporary object can never win
-- resolution. Dynamic SQL is schema-qualified and identifier-quoted, over relation names taken from
-- the catalogue only — never from an argument. Execution is granted to `service_role` alone; the
-- browser reaches this only through the authenticated `admin-academy-deletion` edge function.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Audit table
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- FK-free on purpose, exactly like `account_deletion_audit`: this row must outlive the academy it
-- records. An audit that cascades away with its subject is not an audit.

CREATE TABLE public.academy_deletion_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id  uuid NOT NULL,
  actor_user_id       uuid NOT NULL,
  status              text NOT NULL DEFAULT 'started'
                        CHECK (status IN ('started', 'completed', 'failed')),
  preview_version     integer NOT NULL,
  digest              text NOT NULL,
  deleted_counts      jsonb,
  detached_counts     jsonb,
  blocker_codes       text[],
  failure_reason      text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT chk_academy_deletion_audit_coherent CHECK (
    (status = 'started'   AND finished_at IS NULL AND failure_reason IS NULL)
    OR (status = 'completed' AND finished_at IS NOT NULL AND failure_reason IS NULL)
    OR (status = 'failed'    AND finished_at IS NOT NULL AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX idx_academy_deletion_audit_unfinished
  ON public.academy_deletion_audit (started_at) WHERE status = 'started';

ALTER TABLE public.academy_deletion_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.academy_deletion_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.academy_deletion_audit TO service_role;

COMMENT ON TABLE public.academy_deletion_audit IS
  'Durable evidence of academy deletions. FK-free ids so a row outlives the academy it records. Three-phase: started before anything is touched, completed INSIDE the deletion transaction, failed with a structured reason otherwise. A row stuck at started is a deletion that began and did not finish. Ids, codes and counts only — no PII, no secrets.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The catalogue: what this flow assumes about the schema
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Every relation that would be destroyed by deleting an academy, derived TRANSITIVELY: the direct
-- CASCADE children, plus everything that cascades beneath them. Computed from pg_constraint rather
-- than listed, because a hand-maintained list is exactly what goes stale.
CREATE OR REPLACE FUNCTION public.academy_deletion_cascade_closure()
RETURNS TABLE (relname text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE closure(oid) AS (
    SELECT c.conrelid
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confdeltype = 'c'
       AND c.confrelid = 'public.academy_profiles'::regclass
    UNION
    SELECT c.conrelid
      FROM pg_constraint c
      JOIN closure cl ON cl.oid = c.confrelid
     WHERE c.contype = 'f' AND c.confdeltype = 'c'
       AND c.conrelid <> c.confrelid          -- a self-referencing FK must not loop forever
  )
  SELECT DISTINCT cl.oid::regclass::text FROM closure cl ORDER BY 1;
$$;

-- HOW EACH CASCADE DESCENDANT IS SCOPED TO ONE ACADEMY.
--
-- The closure above says WHICH relations a deletion reaches. It does not say WHICH ROWS, and most
-- descendants have no `academy_profile_id` of their own — `session_player_notes` hangs off
-- `guest_players`, and notes hang off those. An earlier version simply skipped any relation without
-- that column, so those rows were neither counted in the preview nor hashed into the digest: they
-- would be destroyed by a confirmation that never mentioned them, and editing one afterwards would
-- not make the digest stale. That is the exact failure this whole flow exists to prevent.
--
-- So the predicate is DERIVED by walking the FK graph, composing a nested IN for each hop. A
-- relation reachable by several cascade paths gets the OR of them, because a row reached by any path
-- is deleted. Anything that cannot be scoped — a composite FK, or a path deeper than the bound —
-- returns NULL, and the caller fails closed rather than guessing.
CREATE OR REPLACE FUNCTION public.academy_deletion_scope_predicate(
  _relname text, _root text DEFAULT 'academy_profiles', _root_pred text DEFAULT 'id = $1'
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE g(rel, pred, depth) AS (
    -- direct children of the ROOT, scoped by the root's own predicate
    SELECT c.conrelid,
           quote_ident((SELECT a.attname FROM pg_attribute a
                         WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]))
           || ' IN (SELECT ' || quote_ident((SELECT a.attname FROM pg_attribute a
                                              WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]))
           || ' FROM ' || c.confrelid::regclass::text || ' WHERE ' || _root_pred || ')',
           1
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confdeltype = 'c'
       AND c.confrelid = to_regclass('public.' || _root)
       AND array_length(c.conkey, 1) = 1          -- composite FK ⇒ not scoped ⇒ fail closed
    UNION ALL
    -- descendants: this relation's FK column must land in the parent's already-scoped rows
    SELECT c.conrelid,
           quote_ident((SELECT a.attname FROM pg_attribute a
                         WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]))
           || ' IN (SELECT ' || quote_ident((SELECT a.attname FROM pg_attribute a
                                              WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]))
           || ' FROM ' || c.confrelid::regclass::text || ' WHERE ' || g.pred || ')',
           g.depth + 1
      FROM pg_constraint c
      JOIN g ON g.rel = c.confrelid
     WHERE c.contype = 'f' AND c.confdeltype = 'c'
       AND c.conrelid <> c.confrelid
       AND array_length(c.conkey, 1) = 1
       AND g.depth < 6                             -- bound: deeper ⇒ unscoped ⇒ fail closed
  )
  SELECT '(' || string_agg(pred, ' OR ' ORDER BY pred) || ')'
    FROM (SELECT DISTINCT pred FROM g WHERE g.rel = to_regclass('public.' || _relname)) d;
$$;

-- The two overlays no cascade reaches (H3), plus the blocker inputs and the identity state the
-- shared-person blocker reads. Kept here so the lock plan, the digest and the drift guard all read
-- ONE definition of "what this flow depends on".
CREATE OR REPLACE FUNCTION public.academy_deletion_extra_relations()
RETURNS TABLE (relname text, role text)
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM (VALUES
    ('academy_player_metadata',      'overlay'),
    ('academy_player_locations',     'overlay'),
    ('availability_slots',           'detached'),
    ('invoices',                     'blocker'),
    ('cycles',                       'blocker'),
    ('registrations',                'blocker'),
    ('person_links',                 'identity'),
    ('persons',                      'identity'),
    ('academy_player_memberships',   'identity')
  ) AS t(relname, role);
$$;


-- THE SECOND DELETION ROOT — the one no foreign key describes.
--
-- Deleting an academy cascades its `guest_players`, and each of those fires the shipped
-- `cleanup_orphan_person_on_source_delete` trigger (20260826280000), which DELETEs the person when
-- the dying guest was its LAST link. That person then cascades away rows of its own —
-- `notification_contacts` keyed by `person_id`, for instance — and NONE of that is visible in the
-- foreign-key graph rooted at academy_profiles. An earlier version therefore neither counted nor
-- hashed them: they were destroyed by a confirmation that never mentioned them, and editing one
-- afterwards did not make the digest stale.
--
-- Persons reachable from ANOTHER academy are refused outright by SHARED_PERSON_IDENTITY. The ones
-- left here are purely local, genuinely destroyed, and must be previewed like anything else.
CREATE OR REPLACE FUNCTION public.academy_deletion_dying_persons_pred()
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'id IN (SELECT pl.person_id FROM public.person_links pl'
      || ' JOIN public.guest_players g ON g.id = pl.guest_player_id'
      || ' WHERE g.academy_profile_id = $1'
      || '   AND NOT EXISTS (SELECT 1 FROM public.person_links o'
      || '                    WHERE o.person_id = pl.person_id AND o.id <> pl.id))';
$$;

-- Everything the dying persons take with them, declaratively.
CREATE OR REPLACE FUNCTION public.academy_deletion_person_closure()
RETURNS TABLE (relname text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE closure(oid) AS (
    SELECT c.conrelid FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confdeltype = 'c' AND c.confrelid = 'public.persons'::regclass
    UNION
    SELECT c.conrelid FROM pg_constraint c JOIN closure cl ON cl.oid = c.confrelid
     WHERE c.contype = 'f' AND c.confdeltype = 'c' AND c.conrelid <> c.confrelid
  )
  SELECT DISTINCT cl.oid::regclass::text FROM closure cl ORDER BY 1;
$$;

-- FAIL-CLOSED DRIFT GUARD.
--
-- The lock plan, the digest and the delete order all assume a particular schema shape. A later
-- migration could add a CASCADE relation, reclassify one to SET NULL, drop a primary key, introduce
-- a partitioned or view relation, or REPAIR the wrong-target overlay FK — and this flow would go on
-- silently claiming a coverage it no longer has. So the shape is fingerprinted and compared to a
-- reviewed manifest; any difference refuses.
CREATE OR REPLACE FUNCTION public.academy_deletion_catalog_fingerprint()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_input text;
BEGIN
  SELECT
    coalesce(string_agg(line, E'\n' ORDER BY line), '')
    INTO v_input
  FROM (
    -- every FK into academy_profiles, with its delete rule
    SELECT 'fk:' || c.conrelid::regclass::text || ':' || c.confdeltype::text AS line
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'public.academy_profiles'::regclass
    UNION ALL
    -- the transitive cascade closure, as NODES...
    SELECT 'closure:' || cc.relname FROM public.academy_deletion_cascade_closure() cc
    UNION ALL
    -- ...and as EDGES. Membership alone is not enough: an FK added or re-pointed BETWEEN two
    -- relations that are both already in the closure changes what the deletion reaches while leaving
    -- the node set identical. Child, parent, key columns and delete action all participate.
    SELECT 'edge:' || c.conrelid::regclass::text || '->' || c.confrelid::regclass::text
        || ':' || c.confdeltype::text
        || ':' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                              FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum), '-')
        || '>' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                              FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum), '-')
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid IN (SELECT to_regclass('public.' || cc2.relname) FROM public.academy_deletion_cascade_closure() cc2)
    UNION ALL
    -- the trigger-driven root: which relations the dying persons take with them...
    SELECT 'personclosure:' || pc.relname FROM public.academy_deletion_person_closure() pc
    UNION ALL
    -- ...and the TRIGGER itself. Its body decides whether a person dies at all, so a change to it
    -- changes reachability without touching a single foreign key.
    SELECT 'trigger:' || t.tgname || ':' || md5(pg_get_functiondef(t.tgfoid))
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid = 'public.guest_players'::regclass
    UNION ALL
    -- the extra relations this flow depends on, and the CURRENT target of the overlay FK (so
    -- repairing academy_player_locations.academy_profile_id is itself drift)
    SELECT 'extra:' || er.relname || ':' || er.role
      || ':' || coalesce((
           SELECT c2.confrelid::regclass::text
             FROM pg_constraint c2
             JOIN pg_attribute a2 ON a2.attrelid = c2.conrelid AND a2.attnum = c2.conkey[1]
            WHERE c2.contype = 'f' AND c2.conrelid = to_regclass('public.' || er.relname)
              AND a2.attname = 'academy_profile_id'
            LIMIT 1), '-')
      FROM public.academy_deletion_extra_relations() er
    UNION ALL
    -- relkind + primary-key columns of every represented relation: the digest depends on both
    SELECT 'shape:' || r.relname || ':' || c.relkind::text || ':' || coalesce((
             SELECT string_agg(a.attname, ',' ORDER BY x.ord)
               FROM pg_index i
               JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
              WHERE i.indrelid = c.oid AND i.indisprimary), '-')
      FROM (SELECT cc.relname FROM public.academy_deletion_cascade_closure() cc
            UNION SELECT er.relname FROM public.academy_deletion_extra_relations() er) r
      JOIN pg_class c ON c.oid = to_regclass('public.' || r.relname)
  ) lines;

  RETURN encode(extensions.digest(v_input, 'sha256'), 'hex');
END;
$$;

-- THE REVIEWED MANIFEST — a pinned literal, deliberately.
--
-- Not a GUC (a transaction-local setting does not survive a SECURITY DEFINER ... SET boundary, which
-- U1c prerequisite 2 learned the hard way) and not a row in a table that the flow could update
-- itself — a manifest that rewrites itself detects nothing. Changing this value is editing a
-- migration, which is a review. When the catalogue legitimately changes, the new fingerprint is read
-- from `academy_deletion_catalog_fingerprint()` and pinned here in the same migration that changed it.
CREATE OR REPLACE FUNCTION public.academy_deletion_expected_fingerprint()
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT '6bd876a7535b0150cea4a4fef5075bcdd6757821923782a04fb7c24fab28a0f3'::text $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Canonical identity encoding
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- NETSTRING-STYLE, length-prefixed: `<byte_length>:<value>,`. Self-delimiting, so a value containing
-- ':' or ',' cannot be mistaken for a boundary and two different composite tuples cannot encode to
-- the same bytes. Deliberately NOT pre-hashed with md5 — pre-hashing a tuple adds a collision
-- surface and buys nothing when SHA-256 already covers the whole input.
CREATE OR REPLACE FUNCTION public.u1c_ns(_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN _value IS NULL
              THEN '~,'                                   -- NULL is its own token, never '0:,'
              ELSE octet_length(_value)::text || ':' || _value || ',' END;
$$;

COMMENT ON FUNCTION public.u1c_ns(text) IS
  'Length-prefixed (netstring) encoding used to build the academy-deletion digest input. Self-delimiting so composite keys containing the delimiters cannot collide. NULL encodes to its own token, distinct from the empty string.';

-- The identity+revision digest fragment for one relation, scoped by a WHERE clause.
--
-- `xmin` is the revision token: the transaction that last inserted or updated the row. It exists on
-- every ordinary table, needs no schema change, and is NOT row content — so no note, billing email
-- or payment credential ever enters the hash.
CREATE OR REPLACE FUNCTION public.academy_deletion_relation_digest(
  _relname text, _where text, _academy_id uuid
)
RETURNS TABLE (row_count integer, fragment text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_oid oid := to_regclass('public.' || _relname);
  v_pk_expr text;
  v_sql text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'academy_deletion_relation_digest: unknown relation %', _relname
      USING ERRCODE = 'undefined_table';
  END IF;

  -- A relation with no primary key cannot yield a stable identity. Raise rather than contribute
  -- nothing, which would silently weaken the digest.
  SELECT string_agg('public.u1c_ns(' || quote_ident(a.attname) || '::text)', ' || ' ORDER BY x.ord)
    INTO v_pk_expr
    FROM pg_index i
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
   WHERE i.indrelid = v_oid AND i.indisprimary;

  IF v_pk_expr IS NULL THEN
    RAISE EXCEPTION 'academy_deletion_relation_digest: % has no primary key', _relname
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- Schema-qualified and identifier-quoted; `_relname` and `_where` come from this migration's own
  -- catalogue queries, never from a caller argument.
  v_sql := format(
    'SELECT count(*)::int, coalesce(string_agg(tok, '''' ORDER BY tok), '''') FROM ('
    || ' SELECT public.u1c_ns(%L) || %s || public.u1c_ns(t.xmin::text) AS tok'
    || ' FROM %I.%I t WHERE %s) s',
    _relname, v_pk_expr, 'public', _relname, _where);

  RETURN QUERY EXECUTE v_sql USING _academy_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Blockers — ONE definition, used by preview and by confirm
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Extracted from the shipped `guard_owner_has_no_programs` so the trigger and this flow cannot
-- drift: both now call this.
CREATE OR REPLACE FUNCTION public.owner_has_programs(_owner_type text, _owner_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'cycles', (SELECT count(*)::int FROM public.cycles
                WHERE owner_type = _owner_type AND owner_id = _owner_id),
    'registrations', (SELECT count(*)::int FROM public.registrations
                       WHERE owner_type = _owner_type AND owner_id = _owner_id));
$$;

-- The shipped guard, reproduced with its predicate replaced by the helper above. Behaviour for
-- trainer/club/academy is unchanged — same counts, same message, same ERRCODE, same HINT.
CREATE OR REPLACE FUNCTION public.guard_owner_has_no_programs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_type text := TG_ARGV[0];
  v_counts jsonb;
  v_cycles int;
  v_registrations int;
BEGIN
  v_counts := public.owner_has_programs(v_type, OLD.id);
  v_cycles := (v_counts->>'cycles')::int;
  v_registrations := (v_counts->>'registrations')::int;

  IF v_cycles > 0 OR v_registrations > 0 THEN
    RAISE EXCEPTION 'cannot delete %: it still owns % cycle(s) and % registration(s)', v_type, v_cycles, v_registrations
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Delete or transfer the owner''s cycles/registrations first — deleting an owner must never silently orphan its programs (audit R22).';
  END IF;
  RETURN OLD;
END;
$$;

-- The one place a blocker is defined. Every code is evaluated — never short-circuited — so the
-- operator sees every reason at once rather than one per attempt.
CREATE OR REPLACE FUNCTION public.academy_deletion_blockers(_academy_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_invoices int;
  v_programs jsonb;
  v_shared int;
  v_out jsonb := '[]'::jsonb;
BEGIN
  SELECT count(*)::int INTO v_invoices
    FROM public.invoices WHERE academy_profile_id = _academy_id;

  v_programs := public.owner_has_programs('academy', _academy_id);

  -- SHARED IDENTITY. A guest owned by this academy that is its person's LAST person_links row would
  -- have that person destroyed by the cascade. If the person is also reachable from ANOTHER academy,
  -- deleting this one would destroy identity that is not ours to destroy — so we refuse rather than
  -- detach or delete it.
  SELECT count(*)::int INTO v_shared
    FROM public.guest_players g
    JOIN public.person_links pl ON pl.guest_player_id = g.id
   WHERE g.academy_profile_id = _academy_id
     AND NOT EXISTS (SELECT 1 FROM public.person_links other
                      WHERE other.person_id = pl.person_id
                        AND other.id <> pl.id)
     AND (EXISTS (SELECT 1 FROM public.academy_player_memberships m
                   WHERE m.person_id = pl.person_id AND m.academy_profile_id <> _academy_id)
       OR EXISTS (SELECT 1 FROM public.academy_player_metadata am
                   WHERE am.person_id = pl.person_id
                     AND am.academy_profile_id IS NOT NULL
                     AND am.academy_profile_id <> _academy_id));

  IF v_invoices > 0 THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'HAS_INVOICES', 'count', v_invoices));
  END IF;
  IF (v_programs->>'cycles')::int > 0 OR (v_programs->>'registrations')::int > 0 THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'HAS_PROGRAMS',
      'count', (v_programs->>'cycles')::int + (v_programs->>'registrations')::int));
  END IF;
  IF v_shared > 0 THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'SHARED_PERSON_IDENTITY', 'count', v_shared));
  END IF;

  RETURN v_out;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Preview
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.academy_deletion_preview(_academy_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  PREVIEW_VERSION constant integer := 1;
  v_deleted jsonb := '{}'::jsonb;
  v_detached jsonb := '{}'::jsonb;
  v_blockers jsonb;
  v_digest_input text := '';
  v_rel text;
  v_count int;
  v_fragment text;
  v_academy_tok text;
  v_scope text;
  v_person_scope text;
BEGIN
  IF _academy_id IS NULL THEN
    RAISE EXCEPTION 'academy_deletion_preview: _academy_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The academy row itself, identity + revision: any edit to it invalidates the preview.
  SELECT public.u1c_ns('academy_profiles') || public.u1c_ns(a.id::text) || public.u1c_ns(a.xmin::text)
    INTO v_academy_tok
    FROM public.academy_profiles a WHERE a.id = _academy_id;
  IF v_academy_tok IS NULL THEN
    RAISE EXCEPTION 'academy_deletion_preview: no academy %', _academy_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Deleted: the transitive cascade closure, scoped to this academy where the relation carries an
  -- academy_profile_id; plus the two overlays no cascade reaches.
  FOR v_rel IN
    SELECT cc.relname FROM public.academy_deletion_cascade_closure() cc
    UNION SELECT er.relname FROM public.academy_deletion_extra_relations() er WHERE er.role = 'overlay'
    UNION SELECT 'persons'                                     -- the trigger-driven root itself
    UNION SELECT pc.relname FROM public.academy_deletion_person_closure() pc
    ORDER BY 1
  LOOP
    -- The overlays have no FK, so they are scoped by their academy_profile_id VALUE; everything else
    -- is scoped through the cascade graph. A relation that cannot be scoped fails the whole preview
    -- rather than being quietly omitted from what the operator is shown.
    v_scope := public.academy_deletion_scope_predicate(v_rel);

    -- `persons` is not reached by any FK from the academy: the trigger deletes it. Scope it by the
    -- dying-persons predicate directly.
    IF v_rel = 'persons' THEN
      v_scope := public.academy_deletion_dying_persons_pred();
    ELSE
      -- ...and anything the dying persons take with them is scoped through that same root, OR-ed
      -- with whatever the academy graph already reached.
      v_person_scope := public.academy_deletion_scope_predicate(
        v_rel, 'persons', public.academy_deletion_dying_persons_pred());
      IF v_person_scope IS NOT NULL THEN
        v_scope := CASE WHEN v_scope IS NULL THEN v_person_scope
                        ELSE '(' || v_scope || ' OR ' || v_person_scope || ')' END;
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.academy_deletion_extra_relations() er
                WHERE er.relname = v_rel AND er.role = 'overlay') THEN
      -- The overlays are reached BOTH ways and the two sets are not the same: rows keyed by this
      -- academy's id, AND rows keyed only to one of its guests (trainer-owned metadata carries a
      -- NULL academy_profile_id but still cascades away with the guest). Scoping by either predicate
      -- alone under-counts, so the scope is their union.
      v_scope := CASE WHEN v_scope IS NULL THEN '(academy_profile_id = $1)'
                      ELSE '(academy_profile_id = $1 OR ' || v_scope || ')' END;
    END IF;

    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: % is reached by the cascade but cannot be scoped to one academy', v_rel
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT d.row_count, d.fragment INTO v_count, v_fragment
      FROM public.academy_deletion_relation_digest(v_rel, v_scope, _academy_id) d;

    v_deleted := v_deleted || jsonb_build_object(v_rel, v_count);
    v_digest_input := v_digest_input || public.u1c_ns('D:' || v_rel) || public.u1c_ns(v_fragment);
  END LOOP;

  -- Detached, never presented as deleted.
  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('availability_slots', 'academy_profile_id = $1', _academy_id) d;
  v_detached := jsonb_build_object('availability_slots', v_count);
  v_digest_input := v_digest_input || public.u1c_ns('N:availability_slots') || public.u1c_ns(v_fragment);

  -- Blocker inputs contribute identity+revision too, so swapping one invoice for another is stale.
  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('invoices', 'academy_profile_id = $1', _academy_id) d;
  v_digest_input := v_digest_input || public.u1c_ns('B:invoices') || public.u1c_ns(v_fragment);

  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('cycles', 'owner_type = ''academy'' AND owner_id = $1', _academy_id) d;
  v_digest_input := v_digest_input || public.u1c_ns('B:cycles') || public.u1c_ns(v_fragment);

  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('registrations', 'owner_type = ''academy'' AND owner_id = $1', _academy_id) d;
  v_digest_input := v_digest_input || public.u1c_ns('B:registrations') || public.u1c_ns(v_fragment);

  -- The identity state the shared-person blocker reads: a relink must invalidate the preview.
  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('person_links',
      'person_id IN (SELECT pl.person_id FROM public.person_links pl JOIN public.guest_players g ON g.id = pl.guest_player_id WHERE g.academy_profile_id = $1)',
      _academy_id) d;
  v_digest_input := v_digest_input || public.u1c_ns('B:person_links') || public.u1c_ns(v_fragment);

  v_blockers := public.academy_deletion_blockers(_academy_id);

  RETURN jsonb_build_object(
    'preview_version', PREVIEW_VERSION,
    'academy_profile_id', _academy_id,
    'deleted', v_deleted,
    'detached', v_detached,
    'blockers', v_blockers,
    'digest', encode(extensions.digest(
        public.u1c_ns('v' || PREVIEW_VERSION::text)
     || public.u1c_ns(public.academy_deletion_catalog_fingerprint())
     || public.u1c_ns(_academy_id::text)
     || v_academy_tok
     || v_digest_input
     || public.u1c_ns(v_blockers::text), 'sha256'), 'hex'));
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Lock plan
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Separately callable so a two-session test can hold the locks and prove a writer blocks.
--
-- WHY RELATION-LEVEL, AND WHY THIS BROAD. Row locks cannot prevent a PHANTOM INSERT, and several of
-- these relations — the overlays especially — have no usable FK to the academy to key a lock on. So
-- the plan takes SHARE ROW EXCLUSIVE (blocks INSERT/UPDATE/DELETE and itself; still allows SELECT)
-- over every relation whose contents the preview counted. These are intentionally broad locks that
-- briefly block writes application-wide on invoices, persons, person_links and the cascade closure.
-- Academy deletion is rare, admin-initiated and short; the alternative is a deletion that cannot
-- promise what its own preview said. Fixed ascending order, so two concurrent confirms cannot
-- deadlock against each other.
CREATE OR REPLACE FUNCTION public.academy_deletion_lock_plan(_academy_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rel text;
BEGIN
  FOR v_rel IN
    SELECT cc.relname FROM public.academy_deletion_cascade_closure() cc
    UNION SELECT er.relname FROM public.academy_deletion_extra_relations() er
    UNION SELECT 'persons'
    UNION SELECT pc.relname FROM public.academy_deletion_person_closure() pc
    ORDER BY 1
  LOOP
    CONTINUE WHEN to_regclass('public.' || v_rel) IS NULL;
    EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', 'public', v_rel);
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Confirmed deletion
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.academy_delete_confirmed(
  _academy_id uuid,
  _expected_digest text,
  _preview_version integer,
  _audit_id uuid,
  _actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_preview jsonb;
  v_audit public.academy_deletion_audit%ROWTYPE;
  v_blockers jsonb;
  v_stamped uuid;
BEGIN
  -- 1. Catalogue drift, before anything else: if the schema no longer matches what this flow was
  --    reviewed against, nothing it computes can be trusted.
  IF public.academy_deletion_catalog_fingerprint() IS DISTINCT FROM public.academy_deletion_expected_fingerprint() THEN
    RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: the academy-deletion catalogue changed since this flow was reviewed'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 2. The lock plan FIRST — before the authoritative recomputation, so no relevant write can commit
  --    between what we compute and what we delete.
  PERFORM public.academy_deletion_lock_plan(_academy_id);

  PERFORM 1 FROM public.academy_profiles WHERE id = _academy_id FOR UPDATE;

  -- 3. Bind the audit row before any destructive statement, and validate every field.
  SELECT * INTO v_audit FROM public.academy_deletion_audit WHERE id = _audit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AUDIT_NOT_FOUND: no audit row %', _audit_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_audit.academy_profile_id <> _academy_id
     OR v_audit.status <> 'started'
     OR v_audit.digest <> _expected_digest
     OR v_audit.preview_version <> _preview_version
     OR v_audit.actor_user_id <> _actor_user_id THEN
    RAISE EXCEPTION 'AUDIT_BINDING_MISMATCH: audit row % does not match this confirmation', _audit_id
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 4. THE authoritative recomputation, under the locks.
  v_preview := public.academy_deletion_preview(_academy_id);

  IF (v_preview->>'preview_version')::int <> _preview_version
     OR (v_preview->>'digest') <> _expected_digest THEN
    RAISE EXCEPTION 'PREVIEW_STALE: the academy changed since the preview was taken'
      USING ERRCODE = 'raise_exception';
  END IF;

  v_blockers := v_preview->'blockers';
  IF jsonb_array_length(v_blockers) > 0 THEN
    RAISE EXCEPTION 'BLOCKED: %', (SELECT string_agg(b->>'code', ', ' ORDER BY b->>'code')
                                     FROM jsonb_array_elements(v_blockers) b)
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. The overlays no cascade reaches (H3), by academy_profile_id VALUE — the wrong-target FK on
  --    academy_player_locations is NOT repaired here, deliberately.
  DELETE FROM public.academy_player_metadata WHERE academy_profile_id = _academy_id;
  DELETE FROM public.academy_player_locations WHERE academy_profile_id = _academy_id;

  -- 6. The academy: the cascade closure goes with it, academy_mollie_accounts among them — so
  --    payment credentials die only now, after every check has passed, inside this transaction.
  DELETE FROM public.academy_profiles WHERE id = _academy_id;

  -- 7. Stamp the audit with SERVER-RECOMPUTED values, guarded, in this same transaction. Exactly one
  --    row or the whole deletion rolls back: there is no state where the academy is gone and the
  --    audit still reads 'started'.
  UPDATE public.academy_deletion_audit
     SET status = 'completed',
         finished_at = now(),
         deleted_counts = v_preview->'deleted',
         detached_counts = v_preview->'detached',
         blocker_codes = '{}'::text[]
   WHERE id = _audit_id AND status = 'started'
  RETURNING id INTO v_stamped;

  IF v_stamped IS NULL THEN
    RAISE EXCEPTION 'AUDIT_NOT_COMPLETABLE: audit row % was not in state started', _audit_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN jsonb_build_object(
    'academy_profile_id', _academy_id,
    'audit_id', _audit_id,
    'deleted', v_preview->'deleted',
    'detached', v_preview->'detached');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Grants — service_role only. The browser reaches this through the admin edge function alone.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.academy_deletion_cascade_closure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_extra_relations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_scope_predicate(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_dying_persons_pred() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_person_closure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_catalog_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_expected_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_relation_digest(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_blockers(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_preview(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_lock_plan(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_delete_confirmed(uuid, text, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owner_has_programs(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.academy_deletion_preview(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_delete_confirmed(uuid, text, integer, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_lock_plan(uuid) TO service_role;
