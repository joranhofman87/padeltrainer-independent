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
       AND c.confrelid = to_regclass(CASE WHEN _root LIKE '%.%' THEN NULL ELSE 'public.' || _root END)
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
    FROM (SELECT DISTINCT pred FROM g WHERE g.rel = to_regclass(CASE WHEN _relname LIKE '%.%' THEN NULL ELSE 'public.' || _relname END)) d;
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
    ('academy_player_memberships',   'identity'),
    ('person_merge_review',          'mutated')
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
CREATE OR REPLACE FUNCTION public.academy_deletion_dying_persons_pred(_col text DEFAULT 'id')
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- A person dies when the LAST of its links goes, and the trigger fires once PER GUEST, removing
  -- one link each time. So "exactly one link today" is the wrong test: a person linked to TWO guests
  -- of this academy has two links now, yet the first delete removes one and the second then finds
  -- itself last and destroys the person. The right test is that EVERY current link belongs to a
  -- guest of this academy — then nothing survives to keep the person alive.
  SELECT _col || ' IN ('
      || '  SELECT pl.person_id FROM public.person_links pl'
      || '   WHERE pl.guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = $1)'
      || '  EXCEPT'
      || '  SELECT pl2.person_id FROM public.person_links pl2'
      || '   WHERE pl2.guest_player_id IS NULL'
      || '      OR pl2.guest_player_id NOT IN (SELECT g2.id FROM public.guest_players g2 WHERE g2.academy_profile_id = $1)'
      || ')';
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

-- THE OTHER HALF OF KILLING A PERSON — the rows that survive it, changed.
--
-- Three reviews in a row found the same class of defect: an effect of the guest-delete trigger that
-- the declared closure did not model. Enumerating one more relation by hand would have found a
-- fourth. So the effect set is now DERIVED from the catalogue: every foreign key into `persons` is
-- either CASCADE (the row dies — the person closure above), SET NULL (the row survives with its
-- reference cleared — here), or RESTRICT (it cannot happen; the membership blocker refuses first).
-- A new person-keyed column added by a later migration lands in one of these by construction, and
-- the fingerprint below hashes every such key, so one that lands nowhere is drift rather than a
-- silent omission.
-- The persons that do NOT die: linked to a guest of this academy, but also to something outside it.
-- The trigger's ELSE branch drops the dying link and calls `rederive_person`, which recomputes the
-- surviving row's identity fields from the sources that remain. That is a mutation of a person this
-- deletion does not own, so it is previewed as one.
CREATE OR REPLACE FUNCTION public.academy_deletion_surviving_persons_pred()
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'id IN ('
      || '  SELECT pl.person_id FROM public.person_links pl'
      || '   WHERE pl.guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = $1)'
      || '  INTERSECT'
      || '  SELECT pl2.person_id FROM public.person_links pl2'
      || '   WHERE pl2.guest_player_id IS NULL'
      || '      OR pl2.guest_player_id NOT IN (SELECT g2.id FROM public.guest_players g2 WHERE g2.academy_profile_id = $1)'
      || ')';
$$;

-- WHAT THIS FLOW DELETES FROM ONE RELATION — the single definition of it.
--
-- The preview loop and the detach subtraction below both need this, and when they each had their
-- own copy they disagreed: the subtraction knew only about the overlays' `academy_profile_id = $1`
-- arm, so a TRAINER-owned overlay row (academy_profile_id NULL, reached through a cascading guest)
-- was counted as deleted AND as detached. Two true statements about one row is still a wrong
-- preview. One function, two callers, no way to drift.
CREATE OR REPLACE FUNCTION public.academy_deletion_deleted_scope(_relname text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_scope text;
  v_person_scope text;
BEGIN
  -- `persons` is not reached by any FK from the academy: the trigger deletes it.
  IF _relname = 'persons' THEN
    RETURN public.academy_deletion_dying_persons_pred();
  END IF;

  v_scope := public.academy_deletion_scope_predicate(_relname);

  -- ...and anything the dying persons take with them is scoped through that same root, OR-ed with
  -- whatever the academy graph already reached.
  v_person_scope := public.academy_deletion_scope_predicate(
    _relname, 'persons', public.academy_deletion_dying_persons_pred());
  IF v_person_scope IS NOT NULL THEN
    v_scope := CASE WHEN v_scope IS NULL THEN v_person_scope
                    ELSE '(' || v_scope || ' OR ' || v_person_scope || ')' END;
  END IF;

  -- The overlays are reached BOTH ways and the two sets are not the same: rows keyed by this
  -- academy's id, AND rows keyed only to one of its guests (trainer-owned metadata carries a NULL
  -- academy_profile_id but still cascades away with the guest). Either predicate alone under-counts.
  IF EXISTS (SELECT 1 FROM public.academy_deletion_extra_relations() er
              WHERE er.relname = _relname AND er.role = 'overlay') THEN
    v_scope := CASE WHEN v_scope IS NULL THEN '(academy_profile_id = $1)'
                    ELSE '(academy_profile_id = $1 OR ' || v_scope || ')' END;
  END IF;

  -- In the delete set but unscopable: refuse rather than show the operator a partial truth.
  IF v_scope IS NULL
     AND (EXISTS (SELECT 1 FROM public.academy_deletion_cascade_closure() cc WHERE cc.relname = _relname)
       OR EXISTS (SELECT 1 FROM public.academy_deletion_person_closure() pc WHERE pc.relname = _relname)) THEN
    RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: % is reached by the cascade but cannot be scoped to one academy', _relname
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN v_scope;   -- NULL ⇒ this flow deletes nothing from this relation
END;
$$;

-- EVERY relation this flow deletes rows FROM. Three named roots was one root too few twice over;
-- the honest answer is that any relation this transaction deletes from is a parent whose children
-- feel it. This is exactly the set the preview's deleted loop walks, named once so the detach and
-- blocker derivations cannot fall behind it.
CREATE OR REPLACE FUNCTION public.academy_deletion_deletion_parents()
RETURNS TABLE (relname text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cc.relname FROM public.academy_deletion_cascade_closure() cc
  UNION SELECT er.relname FROM public.academy_deletion_extra_relations() er WHERE er.role = 'overlay'
  UNION SELECT 'persons'
  UNION SELECT pc.relname FROM public.academy_deletion_person_closure() pc;
$$;

-- Every SET NULL reference INTO anything this flow deletes: the row survives, changed.
CREATE OR REPLACE FUNCTION public.academy_deletion_detach_targets()
RETURNS TABLE (parent text, parentcol text, relname text, colname text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- schema-resolved on purpose: `::regclass::text` yields 'storage.objects' for a relation outside
  -- `public`, and every consumer here prefixes 'public.'. Anything outside public is not modelled by
  -- this flow at all — and the fingerprint hashes it unfiltered, so its appearance is drift.
  SELECT pcl.relname, pa.attname, cl.relname, a.attname
    FROM pg_constraint con
    JOIN pg_class cl      ON cl.oid  = con.conrelid
    JOIN pg_namespace n   ON n.oid   = cl.relnamespace  AND n.nspname  = 'public'
    JOIN pg_class pcl     ON pcl.oid = con.confrelid
    JOIN pg_namespace pn  ON pn.oid  = pcl.relnamespace AND pn.nspname = 'public'
    JOIN pg_attribute a  ON a.attrelid  = con.conrelid  AND a.attnum  = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
   WHERE con.contype = 'f'
     AND con.confdeltype = 'n'
     AND array_length(con.conkey, 1) = 1     -- a composite key would be drift; see the fingerprint
     AND pcl.relname IN (SELECT dp.relname FROM public.academy_deletion_deletion_parents() dp)
   ORDER BY 3, 4, 1;
$$;

-- The rows of a deletion parent that this flow destroys, as a predicate on a referencing column.
-- It reuses `academy_deletion_deleted_scope`, so a parent's dying set has exactly one definition
-- whether it is being counted, hashed, locked or subtracted.
CREATE OR REPLACE FUNCTION public.academy_deletion_dying_pred(_parent text, _parentcol text, _col text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_scope text := public.academy_deletion_deleted_scope(_parent);
BEGIN
  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: % is a deletion parent with no scope', _parent
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN _col || ' IN (SELECT ' || quote_ident(_parentcol)
      || ' FROM public.' || quote_ident(_parent) || ' WHERE ' || v_scope || ')';
END;
$$;

-- WHAT WOULD REFUSE, DERIVED. RESTRICT and NO ACTION references into a dying root abort the whole
-- transaction — after a clean preview, which is the worst possible moment. `academy_player_memberships`
-- was one (this flow deletes its own first, so it is excluded here); `intake_requests.guest_player_id`
-- is another and nothing deletes those. Rather than discovering them one review at a time, they are
-- read out of the catalogue and reported as blockers before anything is touched.
CREATE OR REPLACE FUNCTION public.academy_deletion_blocking_refs()
RETURNS TABLE (parent text, parentcol text, relname text, colname text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- schema-resolved on purpose: `::regclass::text` yields 'storage.objects' for a relation outside
  -- `public`, and every consumer here prefixes 'public.'. Anything outside public is not modelled by
  -- this flow at all — and the fingerprint hashes it unfiltered, so its appearance is drift.
  SELECT pcl.relname, pa.attname, cl.relname, a.attname
    FROM pg_constraint con
    JOIN pg_class cl      ON cl.oid  = con.conrelid
    JOIN pg_namespace n   ON n.oid   = cl.relnamespace  AND n.nspname  = 'public'
    JOIN pg_class pcl     ON pcl.oid = con.confrelid
    JOIN pg_namespace pn  ON pn.oid  = pcl.relnamespace AND pn.nspname = 'public'
    JOIN pg_attribute a  ON a.attrelid  = con.conrelid  AND a.attnum  = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
   WHERE con.contype = 'f'
     AND con.confdeltype IN ('r', 'a')
     AND array_length(con.conkey, 1) = 1
     AND pcl.relname IN (SELECT dp.relname FROM public.academy_deletion_deletion_parents() dp)
     -- NB: relations this flow partly deletes are NOT excluded here. A relation can be deleted for
     -- THIS academy and still hold a row belonging to another that references a dying parent, and
     -- that surviving row refuses just the same. The exclusion is a row predicate at the count site.
     -- invoices already have their own named blocker; two codes for one fact is not two facts
     AND con.conrelid <> 'public.invoices'::regclass
   ORDER BY 3, 4, 1;
$$;

-- A SET NULL THAT WOULD NOT SURVIVE. `bookings` and `slot_priority_claims` both require an owner —
-- "player_id IS NOT NULL OR guest_player_id IS NOT NULL" — and a guest-only row violates it the
-- moment the FK clears its guest. The transaction aborts after a clean preview, and a guest-only
-- booking is not an exotic state: it is how guests are booked.
--
-- Evaluated per RELATION, not per column. `slot_priority_claims` has two guest columns and a check
-- that reads both; simulating them one at a time says each is survivable and the pair is not. Each
-- detach column is replaced by `CASE WHEN <that column's row is dying> THEN NULL ELSE col END`, so
-- the simulation clears exactly the columns this deletion would clear — no more, which would
-- over-block, and no fewer, which is the bug.
--
-- A NOT NULL detach column cannot be cleared at all: every row in its detach set is a 23502 waiting
-- to happen, so the column itself is the predicate.
CREATE OR REPLACE FUNCTION public.academy_deletion_detach_check_pred(_relname text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rec record;
  v_expr text;
  v_sim text;
  v_out text := NULL;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  FOR v_rec IN
    SELECT dt.parent, dt.parentcol, dt.colname,
           (SELECT a.attnotnull FROM pg_attribute a
             WHERE a.attrelid = to_regclass(CASE WHEN _relname LIKE '%.%' THEN NULL ELSE 'public.' || _relname END) AND a.attname = dt.colname) AS notnull
      FROM public.academy_deletion_detach_targets() dt
     WHERE dt.relname = _relname
     ORDER BY dt.colname
  LOOP
    v_cols := v_cols || v_rec.colname;

    -- NOT NULL: the clear itself is impossible, so every row in the detach set breaks.
    IF v_rec.notnull THEN
      v_out := coalesce(v_out || ' OR ', '')
            || '(' || public.academy_deletion_dying_pred(v_rec.parent, v_rec.parentcol,
                        quote_ident(v_rec.colname)) || ')';
    END IF;
  END LOOP;

  IF array_length(v_cols, 1) IS NULL THEN
    RETURN v_out;
  END IF;

  FOR v_expr IN
    SELECT pg_get_expr(con.conbin, con.conrelid)
      FROM pg_constraint con
     WHERE con.contype = 'c' AND con.conrelid = to_regclass(CASE WHEN _relname LIKE '%.%' THEN NULL ELSE 'public.' || _relname END)
       -- conkey names the columns a check reads: no parsing needed to find the relevant ones
       AND EXISTS (SELECT 1 FROM unnest(v_cols) c
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attname = c
                   WHERE a.attnum = ANY (con.conkey))
     ORDER BY con.conname
  LOOP
    -- A quoted literal could contain a column name and would be corrupted by substitution — and it
    -- would leave no residual match to notice afterwards. Refuse rather than rewrite blind.
    IF v_expr LIKE '%''%' THEN
      RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: the check on % contains a literal and cannot be simulated', _relname
        USING ERRCODE = 'raise_exception';
    END IF;

    v_sim := v_expr;
    FOR v_rec IN
      SELECT dt.parent, dt.parentcol, dt.colname FROM public.academy_deletion_detach_targets() dt
       WHERE dt.relname = _relname ORDER BY dt.colname
    LOOP
      v_sim := regexp_replace(v_sim, '\m' || v_rec.colname || '\M',
        '(CASE WHEN ' || public.academy_deletion_dying_pred(v_rec.parent, v_rec.parentcol,
                           quote_ident(v_rec.colname))
        || ' THEN NULL ELSE ' || quote_ident(v_rec.colname) || ' END)', 'g');
    END LOOP;

    v_out := coalesce(v_out || ' OR ', '') || 'NOT coalesce(' || v_sim || ', true)';
  END LOOP;

  RETURN v_out;   -- NULL ⇒ nothing about this relation can break when its references are cleared
END;
$$;

-- A row is announced in exactly ONE category, by precedence deleted > mutated > detached: an
-- academy_player_metadata row that is both destroyed with the academy and referenced by a dying
-- person must read as deleted, not as both. This returns what a relation has ALREADY been counted
-- for, so the detach arm can subtract it.
CREATE OR REPLACE FUNCTION public.academy_deletion_already_counted_pred(_relname text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- person_merge_review is counted whole by the trigger arms — pending as deleted, applied as
  -- mutated — and no foreign key describes that, so it is the one case the scope walker cannot see.
  SELECT CASE WHEN _relname = 'person_merge_review'
         THEN 'guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = $1)'
         ELSE coalesce(public.academy_deletion_deleted_scope(_relname), 'false')
         END;
$$;

-- EVERY relation this transaction writes to, as trigger roots.
--
-- Not only what it deletes: clearing a person reference is an UPDATE, and `invoices`, `bookings`,
-- `intake_requests` and `slot_priority_claims` all carry triggers that fire on one. Leaving the
-- detach targets out meant a trigger could be added to `invoices` — or `trg_stamp_person_id_invoices`
-- rewritten — and change what this transaction does without registering as drift.
CREATE OR REPLACE FUNCTION public.academy_deletion_trigger_root_relations()
RETURNS TABLE (oid oid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'public.academy_profiles'::regclass::oid
  UNION SELECT to_regclass('public.' || cc.relname)::oid FROM public.academy_deletion_cascade_closure() cc
  UNION SELECT to_regclass('public.' || pc.relname)::oid FROM public.academy_deletion_person_closure() pc
  UNION SELECT to_regclass('public.' || dt.relname)::oid FROM public.academy_deletion_detach_targets() dt
  UNION SELECT to_regclass('public.' || er.relname)::oid FROM public.academy_deletion_extra_relations() er
  UNION SELECT 'public.persons'::regclass::oid
  UNION SELECT 'public.guest_players'::regclass::oid
  -- the flow's OWN audit table: the completion stamp is a write like any other, and a trigger added
  -- to it could act on data this preview never mentioned. It is deliberately not in the LOCK plan —
  -- nothing destroys it, its own row is already locked FOR UPDATE, and locking the whole table would
  -- serialise unrelated academies' audit rows for no correctness gain.
  UNION SELECT 'public.academy_deletion_audit'::regclass::oid;
$$;

-- Everything the trigger bodies CALL, transitively.
--
-- Hashing a trigger's own definition is not enough: `cleanup_orphan_person_on_source_delete` decides
-- what happens to a surviving person by calling `rederive_person`, and a later migration could
-- change that helper's mutation behaviour without touching a single trigger. Postgres records no
-- function→function dependency (bodies are not parsed for them), so the closure is taken over the
-- definition TEXT: any public function whose name appears as a word in a reached definition is
-- itself reached, to a fixpoint. It errs wide — an unrelated edit to a matched helper reads as
-- drift — which is the direction a fail-closed guard should err in.
CREATE OR REPLACE FUNCTION public.academy_deletion_trigger_helper_defs()
RETURNS TABLE (sig text, def text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH RECURSIVE roots AS (
    SELECT DISTINCT t.tgfoid AS oid
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid IN (
             SELECT r.oid FROM public.academy_deletion_trigger_root_relations() r)
  ), reach(oid) AS (
    SELECT oid FROM roots
    UNION
    SELECT p.oid
      FROM reach r
      JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace
                    AND p.prokind = 'f'
                    AND p.oid <> r.oid
     WHERE pg_get_functiondef(r.oid) ~ ('\m' || p.proname || '\M')
  )
  SELECT r.oid::regprocedure::text, pg_get_functiondef(r.oid)
    FROM reach r
   WHERE r.oid NOT IN (SELECT oid FROM roots)   -- the roots are already hashed with their triggers
   ORDER BY 1;
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
    -- child, delete action AND the full key shape. Without the keys, repointing
    -- `availability_slots.academy_profile_id` at a different unique column of academy_profiles
    -- leaves this line identical while Postgres clears a different set of slots than the preview —
    -- whose scope for that relation is the hard-coded `academy_profile_id = $1`.
    SELECT 'fk:' || c.conrelid::regclass::text || ':' || c.confdeltype::text
        || ':' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                              FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum), '-')
        || '>' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                              FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum), '-') AS line
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
    -- ...and EVERY foreign key into persons, with its full key and delete rule. This is what makes
    -- the derived effect model safe: a new person-keyed column, or one reclassified between CASCADE,
    -- SET NULL and RESTRICT, moves a relation between deleted / detached / refused. Hashing the keys
    -- themselves means such a change cannot pass as "already covered".
    SELECT 'rootfk:' || con.confrelid::regclass::text || ':' || con.conrelid::regclass::text
        || ':' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                              FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum), '-')
        || ':' || con.confdeltype::text
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confrelid IN (SELECT to_regclass('public.' || dp.relname)
                               FROM public.academy_deletion_deletion_parents() dp)
    UNION ALL
    -- ...and the TRIGGER itself. Its body decides whether a person dies at all, so a change to it
    -- changes reachability without touching a single foreign key.
    -- RAW definitions, length-delimited, for every non-internal trigger on the academy, on either
    -- closure, and on the trigger roots. `pg_get_triggerdef` carries enablement, events, WHEN and
    -- arguments — all of which change behaviour without touching the function body — and the body
    -- itself decides whether a person dies at all. No md5 pre-hash: the outer SHA-256 hashes the
    -- whole input, and pre-hashing would only add a collision surface.
    SELECT 'trigger:' || public.u1c_ns(t.tgrelid::regclass::text) || public.u1c_ns(t.tgname)
        || public.u1c_ns(pg_get_triggerdef(t.oid)) || public.u1c_ns(pg_get_functiondef(t.tgfoid))
      FROM pg_trigger t
     WHERE NOT t.tgisinternal
       AND t.tgrelid IN (
             SELECT r.oid FROM public.academy_deletion_trigger_root_relations() r)
    UNION ALL
    -- CHECK CONSTRAINTS on the detach targets. `DETACH_BREAKS_CONSTRAINT` is computed FROM these, so
    -- a check added, altered or dropped changes which deletions are refused. Hashing the FK graph
    -- but not the checks it is simulated against would leave the blocker's own input unreviewed.
    SELECT 'check:' || public.u1c_ns(con.conrelid::regclass::text) || public.u1c_ns(con.conname)
        || public.u1c_ns(pg_get_expr(con.conbin, con.conrelid))
      FROM pg_constraint con
     WHERE con.contype = 'c'
       AND con.conrelid IN (SELECT to_regclass('public.' || dt.relname)
                              FROM public.academy_deletion_detach_targets() dt)
    UNION ALL
    -- REWRITE RULES. A `DO ALSO` rule on a written relation adds statements to this transaction
    -- without appearing in pg_constraint, pg_trigger, or any function body — the three things
    -- hashed above. Rules are rare in this schema, which is exactly why their absence has to be
    -- part of what was reviewed rather than an assumption.
    SELECT 'rule:' || public.u1c_ns(r.ev_class::regclass::text) || public.u1c_ns(r.rulename)
        || public.u1c_ns(pg_get_ruledef(r.oid))
      FROM pg_rewrite r
     WHERE r.ev_class IN (SELECT tr.oid FROM public.academy_deletion_trigger_root_relations() tr)
    UNION ALL
    -- ...and everything those trigger bodies call, transitively — `rederive_person` above all.
    SELECT 'helper:' || public.u1c_ns(h.sig) || public.u1c_ns(h.def)
      FROM public.academy_deletion_trigger_helper_defs() h
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
AS $$ SELECT '2238f9c213c1c87b3c6233d42148ee1be33c4173a50dc8ef9758f75d4997ba57'::text $$;

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
  v_oid oid := to_regclass(CASE WHEN _relname LIKE '%.%' THEN NULL ELSE 'public.' || _relname END);
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
  v_blocking int;
  v_breaking int;
  v_n int;
  v_check text;
  v_rec record;
BEGIN
  SELECT count(*)::int INTO v_invoices
    FROM public.invoices WHERE academy_profile_id = _academy_id;

  v_programs := public.owner_has_programs('academy', _academy_id);

  -- SHARED IDENTITY. A guest owned by this academy that is its person's LAST person_links row would
  -- have that person destroyed by the cascade. If the person is also reachable from ANOTHER academy,
  -- deleting this one would destroy identity that is not ours to destroy — so we refuse rather than
  -- detach or delete it.
  -- The SAME "will die" definition the preview uses: every current link belongs to a guest of this
  -- academy. Two definitions of the same thing is how a preview and a deletion drift apart.
  SELECT count(*)::int INTO v_shared
    FROM (
      SELECT pl.person_id FROM public.person_links pl
       WHERE pl.guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = _academy_id)
      EXCEPT
      SELECT pl2.person_id FROM public.person_links pl2
       WHERE pl2.guest_player_id IS NULL
          OR pl2.guest_player_id NOT IN (SELECT g2.id FROM public.guest_players g2 WHERE g2.academy_profile_id = _academy_id)
    ) pl
   WHERE (EXISTS (SELECT 1 FROM public.academy_player_memberships m
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

  -- References that would REFUSE, and detaches that would break a check. Both abort the transaction
  -- if left to be discovered by Postgres, so both are counted here and refused up front.
  v_blocking := 0;
  FOR v_rec IN SELECT * FROM public.academy_deletion_blocking_refs() LOOP
    -- the reference is dying AND this row is not one the flow deletes on its way past
    EXECUTE format('SELECT count(*)::int FROM public.%I WHERE %s AND NOT coalesce(%s, false)',
                   v_rec.relname,
                   public.academy_deletion_dying_pred(v_rec.parent, v_rec.parentcol,
                     quote_ident(v_rec.colname)),
                   coalesce(public.academy_deletion_deleted_scope(v_rec.relname), 'false'))
      INTO v_n USING _academy_id;
    v_blocking := v_blocking + v_n;
  END LOOP;
  IF v_blocking > 0 THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'BLOCKING_REFERENCES', 'count', v_blocking));
  END IF;

  v_breaking := 0;
  FOR v_rec IN SELECT DISTINCT dt.relname FROM public.academy_deletion_detach_targets() dt ORDER BY 1 LOOP
    v_check := public.academy_deletion_detach_check_pred(v_rec.relname);
    CONTINUE WHEN v_check IS NULL;
    EXECUTE format('SELECT count(*)::int FROM public.%I WHERE %s', v_rec.relname, v_check)
      INTO v_n USING _academy_id;
    v_breaking := v_breaking + v_n;
  END LOOP;
  IF v_breaking > 0 THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'DETACH_BREAKS_CONSTRAINT', 'count', v_breaking));
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
  v_mutated jsonb := '{}'::jsonb;
  v_blockers jsonb;
  v_digest_input text := '';
  v_rel text;
  v_count int;
  v_fragment text;
  v_academy_tok text;
  v_scope text;
  v_person_scope text;
  v_col text;
  v_parent text;
  v_parentcol text;
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
    v_scope := public.academy_deletion_deleted_scope(v_rel);
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: % is in the delete set but cannot be scoped', v_rel
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

  -- ...and the SET NULL side of killing a person, derived from the catalogue rather than listed.
  -- A booking, an invoice or a priority claim belonging to SOMEONE ELSE can carry a reference to a
  -- person this academy happens to own the only links to. Deleting that person clears the reference:
  -- the row survives, changed, and an operator who was never shown it has not been told the truth.
  -- Keyed by relation.column, because `bookings` has two such columns and they detach independently.
  FOR v_parent, v_parentcol, v_rel, v_col IN
    SELECT dt.parent, dt.parentcol, dt.relname, dt.colname
      FROM public.academy_deletion_detach_targets() dt ORDER BY 3, 4, 1
  LOOP
    -- coalesce, and not merely NOT: a trainer-owned overlay row has a NULL academy_profile_id, so
    -- `NOT (academy_profile_id = $1)` is NULL rather than true and three-valued logic drops the row
    -- from the detached set entirely — a row whose reference this transaction clears, announced
    -- nowhere. Unknown means "not already counted", which is the only reading that is safe here.
    v_scope := public.academy_deletion_dying_pred(v_parent, v_parentcol, quote_ident(v_col))
            || ' AND NOT coalesce(' || public.academy_deletion_already_counted_pred(v_rel) || ', false)';

    SELECT d.row_count, d.fragment INTO v_count, v_fragment
      FROM public.academy_deletion_relation_digest(v_rel, v_scope, _academy_id) d;

    v_detached := v_detached || jsonb_build_object(v_rel || '.' || v_col,
      coalesce((v_detached->>(v_rel || '.' || v_col))::int, 0) + v_count);
    v_digest_input := v_digest_input || public.u1c_ns('N:' || v_rel || '.' || v_col) || public.u1c_ns(v_fragment);
  END LOOP;

  -- The persons this deletion does NOT own but still changes: the trigger drops their dying link and
  -- rederives their identity fields from whatever sources remain. Announced as mutated, and hashed,
  -- so an edit to one of them between preview and confirmation is stale like anything else.
  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('persons',
      public.academy_deletion_surviving_persons_pred(), _academy_id) d;
  v_mutated := v_mutated || jsonb_build_object('persons', v_count);
  v_digest_input := v_digest_input || public.u1c_ns('M:persons') || public.u1c_ns(v_fragment);

  -- ...and what rederiving one reaches. `rederive_person` names `user_id` in its SET list every
  -- time, so `trg_notif_person_sync_effective_user` (AFTER UPDATE OF user_id) fires for every
  -- surviving person and rewrites that person's notification contacts, which in turn recompute
  -- their own effective_user_id. None of that is a foreign-key action and none of it was announced.
  --
  -- Derived from the person closure rather than named, and deliberately CONSERVATIVE: it announces
  -- every row of those relations belonging to a surviving person, some of which the triggers will
  -- leave untouched. Naming a row that turns out unchanged cannot mislead an operator about what
  -- they are about to do; staying silent about one that changes can.
  FOR v_rel IN
    SELECT pc.relname FROM public.academy_deletion_person_closure() pc ORDER BY 1
  LOOP
    v_person_scope := public.academy_deletion_scope_predicate(
      v_rel, 'persons', public.academy_deletion_surviving_persons_pred());
    CONTINUE WHEN v_person_scope IS NULL;

    SELECT d.row_count, d.fragment INTO v_count, v_fragment
      FROM public.academy_deletion_relation_digest(v_rel, v_person_scope, _academy_id) d;

    -- a row already counted as deleted (the dying link) is not also announced as mutated
    IF v_count > 0 OR NOT (v_deleted ? v_rel) THEN
      v_mutated := v_mutated || jsonb_build_object(v_rel, v_count);
    END IF;
    v_digest_input := v_digest_input || public.u1c_ns('M:' || v_rel) || public.u1c_ns(v_fragment);
  END LOOP;

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

  -- THE GUEST TRIGGER'S OTHER SIDE EFFECT. Deleting a guest does not only maybe-delete its person:
  -- `cleanup_orphan_person_on_source_delete` also DELETEs that guest's PENDING person_merge_review
  -- rows outright and SCRUBS the identifying payload off its APPLIED ones (the merge fact survives,
  -- the who does not). Neither is reachable by any foreign key from the academy, so both were
  -- invisible to the preview: a pending review would be destroyed unannounced, and an applied one
  -- materially altered. Pending rows are counted as deleted; applied rows are announced as MUTATED,
  -- a third category, because calling a scrub a deletion would be as misleading as saying nothing.
  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('person_merge_review',
      'status = ''pending'' AND guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = $1)',
      _academy_id) d;
  v_deleted := v_deleted || jsonb_build_object('person_merge_review', v_count);
  v_digest_input := v_digest_input || public.u1c_ns('D:person_merge_review') || public.u1c_ns(v_fragment);

  SELECT d.row_count, d.fragment INTO v_count, v_fragment
    FROM public.academy_deletion_relation_digest('person_merge_review',
      'status IS DISTINCT FROM ''pending'' AND guest_player_id IN (SELECT g.id FROM public.guest_players g WHERE g.academy_profile_id = $1)',
      _academy_id) d;
  v_mutated := v_mutated || jsonb_build_object('person_merge_review', v_count);
  v_digest_input := v_digest_input || public.u1c_ns('M:person_merge_review') || public.u1c_ns(v_fragment);

  v_blockers := public.academy_deletion_blockers(_academy_id);

  RETURN jsonb_build_object(
    'preview_version', PREVIEW_VERSION,
    'academy_profile_id', _academy_id,
    'deleted', v_deleted,
    'detached', v_detached,
    'mutated', v_mutated,
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
    -- the SET NULL side: these are WRITTEN by the deletion (their reference is cleared), so a
    -- concurrent writer to one of them must wait exactly as it does for a row being destroyed
    UNION SELECT dt.relname FROM public.academy_deletion_detach_targets() dt
    -- the blocker's INPUTS. `intake_requests` is protected today only because it happens to be a
    -- detach target as well; a restrictive child with no SET NULL key of its own could take a
    -- committed reference between the blocker recomputation and the delete, and refuse it.
    UNION SELECT br.relname FROM public.academy_deletion_blocking_refs() br
    -- the root itself. It was missing: only its ROW was locked, so a concurrent CREATE TRIGGER on
    -- academy_profiles could take its lock AFTER the fingerprint was checked and fire during the
    -- delete. A table lock here closes that window for the same reason it does everywhere else —
    -- CREATE TRIGGER takes SHARE ROW EXCLUSIVE, which this conflicts with.
    UNION SELECT 'academy_profiles'
    ORDER BY 1
  LOOP
    CONTINUE WHEN to_regclass('public.' || v_rel) IS NULL;
    EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', 'public', v_rel);
  END LOOP;

  -- The audit table gets the WEAKEST lock that still conflicts with trigger DDL. It is not being
  -- destroyed and its own row is already held FOR UPDATE, so SHARE ROW EXCLUSIVE would only
  -- serialise unrelated academies' audit writes; ROW EXCLUSIVE blocks the DDL and nothing else.
  LOCK TABLE public.academy_deletion_audit IN ROW EXCLUSIVE MODE;
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

  -- 4b. The catalogue again, now that the locks are held and the recomputation is done.
  --
  -- The relation locks stop concurrent DDL on TABLES, but nothing locks a FUNCTION: a
  -- `CREATE OR REPLACE FUNCTION` on `rederive_person` or any reached helper can commit between the
  -- first check and here, and its new behaviour would run against a fingerprint nobody compared.
  -- Re-reading it under the locks narrows that window to the statements below.
  --
  -- It does not CLOSE it, and cannot: closing it needs a schema-change exclusion protocol that
  -- migrations also honour, which is a deployment-wide change and not this checkpoint's to make.
  -- Recorded as an open item rather than papered over.
  IF public.academy_deletion_catalog_fingerprint() IS DISTINCT FROM public.academy_deletion_expected_fingerprint() THEN
    RAISE EXCEPTION 'ACADEMY_DELETION_CATALOG_DRIFT: the catalogue changed while this deletion was preparing'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. The overlays no cascade reaches (H3), by academy_profile_id VALUE — the wrong-target FK on
  --    academy_player_locations is NOT repaired here, deliberately.
  DELETE FROM public.academy_player_metadata WHERE academy_profile_id = _academy_id;
  DELETE FROM public.academy_player_locations WHERE academy_profile_id = _academy_id;

  -- This academy's OWN memberships, explicitly, before the academy goes.
  -- `academy_player_memberships.person_id` is ON DELETE RESTRICT. Deleting the academy cascades
  -- both `guest_players` and `academy_player_memberships`, and the order between two FK action
  -- triggers is not a contract: if the guests go first, their cleanup trigger tries to delete a
  -- person the membership row still references and RESTRICT aborts the whole transaction. An
  -- academy with memberships for its own players — which after U1b is every academy — could not be
  -- deleted at all. The preview already counts these as deleted; this only makes the execution
  -- order match what was announced.
  DELETE FROM public.academy_player_memberships WHERE academy_profile_id = _academy_id;

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
         detached_counts = jsonb_build_object(
           'detached', v_preview->'detached', 'mutated', v_preview->'mutated'),
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
    'detached', v_preview->'detached',
    'mutated', v_preview->'mutated');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Grants — service_role only. The browser reaches this through the admin edge function alone.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.academy_deletion_cascade_closure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_extra_relations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_scope_predicate(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_dying_persons_pred(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_person_closure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_catalog_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_expected_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_relation_digest(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_blockers(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_preview(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_deleted_scope(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_trigger_root_relations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_deletion_parents() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_blocking_refs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_detach_check_pred(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_detach_targets() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_dying_pred(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_surviving_persons_pred() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_already_counted_pred(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_trigger_helper_defs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_deletion_lock_plan(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_delete_confirmed(uuid, text, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owner_has_programs(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.academy_deletion_preview(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_delete_confirmed(uuid, text, integer, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_deleted_scope(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_trigger_root_relations() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_deletion_parents() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_blocking_refs() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_detach_check_pred(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_detach_targets() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_dying_pred(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_surviving_persons_pred() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_already_counted_pred(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_trigger_helper_defs() TO service_role;
GRANT EXECUTE ON FUNCTION public.academy_deletion_lock_plan(uuid) TO service_role;
