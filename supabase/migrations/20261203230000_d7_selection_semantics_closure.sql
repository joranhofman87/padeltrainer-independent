-- D7 RUNTIME — THE TERMINAL SEMANTICS CLOSURE: LABEL, OCCURRENCES, VERSION, CONTACTS.
--
-- OWNER DECISIONS (`APPROVE_D7_RUNTIME_TERMINAL_SEMANTICS_AND_RECOVERY_CLOSURE_V1`):
--   OD1  MUTABLE_CONTACTS_AND_TIMESTAMPED_DISCLOSURE
--   OD2  PROCEED_ON_CONTACT_DELTA_AND_DISCLOSE_AT_APPLY_AND_SEND
--   OD3  DISCLOSE_ACADEMY_SCOPED_ROUND_VERSION_FOR_EXTEND
--   OD4  SESSION_PRICE_STAYS_REFUSED  (nothing in this file touches it)
--
-- ── WHY ONE FILE AND NOT THE TWO THE DOSSIER PROPOSED ───────────────────────────────────────
--
-- The plan named `20261203230000` and `20261203240000` as separate migrations. They are merged
-- here, and the reason is correctness rather than tidiness.
--
-- `d7_p_selection_digest` gains a parameter. In PostgreSQL a `CREATE OR REPLACE FUNCTION` with a
-- new parameter list creates an OVERLOAD; it does not replace. Had the preview moved to the
-- nine-argument digest in one migration and the apply followed in the next, then between those two
-- transactions the preview would have digested WITH the round version and the apply WITHOUT it —
-- every apply answering `selection_moved` against a digest the preview had just issued. That is
-- precisely the round-1 defect that made the digest one shared function in the first place, and a
-- migration boundary is no safer a place to split it than two inline copies were.
--
-- Anything that must change together changes in one transaction. This is that transaction.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────
--
-- 1. `d7_p_selection_digest` — the round version becomes part of an extend's digested premise.
-- 2. `rebook_round_selection_preview_as_actor` — one boundary label normalization; a typed
--    zero-occurrence refusal that issues NO fingerprint and NO digest; the round version and the
--    contact-snapshot timestamp on the result row.
-- 3. `rebook_round_selection_apply_as_actor` — the same normalization with the same constant; the
--    same zero-occurrence refusal, in the typed vocabulary, before the frozen writer can raise a
--    bare `22023`; and the current contact counts on a written receipt.
--
-- ── HOW THE TWO WRAPPERS WERE PRODUCED ──────────────────────────────────────────────────────
--
-- Not by transcription. The bodies are the reviewed text of `20261203190000` and `20261203210000`,
-- transformed by exact, asserted substitutions and re-issued whole. Everything not substituted is
-- byte-identical to the reviewed source BY CONSTRUCTION rather than by inspection — the discipline
-- `20261203200000` applies to the frozen cores, for the same reason: a silent transcription error
-- inside an apply writer is the class of defect nobody finds by reading.
--
-- Both wrappers DROP before they CREATE, because both return tables gain columns and PostgreSQL
-- will not replace a function's return type. Dropping discards the ACL, so ownership and the one
-- `authenticated` grant are re-asserted below rather than assumed.
--
-- FROZEN ABC-27 IS NOT TOUCHED. Nothing here amends an already-issued migration; all three
-- routines are superseded in place.

DO $d7_semantics_closure$
DECLARE
  v_a name;
  v_p name;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure('public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date)') IS NULL
     OR to_regprocedure('public.rebook_round_selection_preview_as_actor(uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[])') IS NULL
     OR to_regprocedure('public.rebook_round_selection_apply_as_actor(uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],bytea)') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the selection surfaces)';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.rebook_round_preview_normalized_core(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])');
  IF v_a IS NULL OR v_p IS NULL OR v_a = v_p THEN
    RAISE EXCEPTION 'D7 semantics closure: the two domain owners did not resolve distinctly (A=%, P=%)', v_a, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER')
     OR NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 semantics closure: % is not a member of both domain owners', current_user;
  END IF;

  -- ── (1) THE DIGEST ────────────────────────────────────────────────────────────────────────
  DROP FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date);
  CREATE FUNCTION public.d7_p_selection_digest(
    p_academy       uuid,
    p_candidates    uuid[],
    p_mode          text,
    p_term_end      date,
    p_round         uuid,
    p_round_label   text,
    p_excluded_keys text[],
    p_target_start  date,
    -- ── THE ROUND'S VERSION, FOR `extend` ──
    --
    -- OWNER DECISION `EXTEND=RETURN_AND_DIGEST_THE_MANAGER_SCOPED_ROUND_VERSION`. NULL for a
    -- create, which is why an added parameter rather than a second function: one digest formula,
    -- computed identically by both surfaces, is the invariant round 1 established after the two
    -- inline copies drifted and every apply answered `selection_moved`.
    p_round_version int
  ) RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $dg$
    SELECT sha256(convert_to(
             coalesce((SELECT string_agg(c.series_key || '>' || c.slot_id::text
                          || '>' || coalesce(c.tmpl_price::text, '')
                          || '>' || coalesce(c.tmpl_split::text, '')
                          || '>' || coalesce(c.tmpl_vat::text, '')
                          || '>' || coalesce(c.tmpl_max::text, '')
                          || '>' || coalesce(c.tmpl_minutes::text, ''), '|'
                        ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id)
                         FROM public.d7_p_series_cluster(p_academy, p_candidates, p_mode,
                                p_term_end, p_round, p_round_label, p_excluded_keys) c
                        WHERE c.qualifies AND NOT c.suppressed), '')
             -- REVIEW ROUND 2 (P1): THE LABEL IS NOT IN HERE. It is the OPERATOR's own field, and
             -- both wizards already invalidate a review when their body changes — but the cohort
             -- auto-count does not carry a label at all, so digesting it made the first review
             -- after every count a guaranteed `selection_moved`: the server was comparing the
             -- count's empty label against the review's real one. What this digest must fence is
             -- the SERVER's state moving underneath an unchanged request, and the round's taken
             -- names below cover the part of naming that can do that.
             -- LENGTH-PREFIXED, NOT JUST DELIMITED.
             --
             -- REVIEW ROUND 4 (P1): a raw separator makes the serialization non-injective. A round
             -- holding the two names {`X`, `z`} and one holding the single name `X<U+0001>z`
             -- produced the SAME bytes, so a concurrent transaction could swap one set for the
             -- other, the echoed digest would still match, and the operator would approve a name
             -- derived from the first set while the core named from the second. Prefixing each
             -- element with its own length makes the encoding unambiguous whatever the data holds.
             || E'\n' || coalesce((SELECT string_agg(length(n.name) || ':' || n.name, E'\u0001'
                                            ORDER BY n.name)
                                     FROM (SELECT DISTINCT name FROM
                                             public.d7_p_round_taken_names(p_academy, p_round, p_target_start)) n), '')
             -- REVIEW ROUND 3 (P1): THE TRAINER AND LOCATION DISPLAY NAMES ARE IN HERE TOO. They
             -- are naming-chain inputs, the wrapper reads them in one statement and the core reads
             -- them again in a later one, and a trainer renaming themselves in between produced a
             -- review showing the OLD name beside a fingerprint for the NEW one — which then
             -- applied successfully, writing a name nobody approved. Every input the chain is a
             -- function of now moves the digest.
             || E'\n' || coalesce((SELECT string_agg(length(d.kind || d.subject_id::text
                                              || coalesce(d.display_name, '')) || ':'
                                            || d.kind || ':' || d.subject_id::text || '='
                                            || coalesce(d.display_name, ''), E'\u0001'
                                            ORDER BY d.kind, d.subject_id)
                                     FROM public.d7_p_display_names(
                                            ARRAY(SELECT DISTINCT c.trainer_id
                                                    FROM public.d7_p_series_cluster(p_academy, p_candidates,
                                                           p_mode, p_term_end, p_round, p_round_label,
                                                           p_excluded_keys) c
                                                   WHERE c.qualifies AND NOT c.suppressed
                                                     AND c.trainer_id IS NOT NULL),
                                            ARRAY(SELECT DISTINCT c.location_id
                                                    FROM public.d7_p_series_cluster(p_academy, p_candidates,
                                                           p_mode, p_term_end, p_round, p_round_label,
                                                           p_excluded_keys) c
                                                   WHERE c.qualifies AND NOT c.suppressed
                                                     AND c.location_id IS NOT NULL)) d), '')
             -- THE ROUND'S VERSION IS PART OF AN EXTEND'S PREMISE, and unlike a recipient's
             -- email address it is not a mutable attribute of a third party — it is the state of
             -- the very round being extended. Digesting it puts the friendlier `selection_moved`
             -- ("look again here") in front of the core's `expected_version_mismatch`, without
             -- weakening the fence: the core still checks the version it was given.
             --
             -- Length-prefixed like every other element, for the injectivity reason round 4
             -- recorded: a raw separator lets two different element sets serialize identically.
             || E'\n' || length(coalesce(p_round_version::text, ''))::text
                        || ':' || coalesce(p_round_version::text, ''),
             'UTF8'))
  $dg$;

  EXECUTE format('ALTER FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date,int) OWNER TO %I', v_p);
  REVOKE ALL ON FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date,int)
    FROM PUBLIC, anon, authenticated, service_role;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date,int) TO %I', v_a);

  -- ── (2) THE PREVIEW SURFACE ───────────────────────────────────────────────────────────────
  DROP FUNCTION public.rebook_round_selection_preview_as_actor(uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[]);
  CREATE FUNCTION public.rebook_round_selection_preview_as_actor(
    p_academy_profile_id   uuid,
    p_contract_version     text,
    p_command_kind         text,
    -- THE TWO CLOSED VOCABULARIES.
    p_selection_mode       text,   -- 'source_cycle' | 'cohort'
    p_projection           text,   -- 'counts' | 'review'
    -- Source-cycle mode names a cyclus; cohort mode names locations and a term-end week.
    p_source_cycle_id      uuid,
    p_location_ids         uuid[],
    p_term_end             date,
    -- The operator's manual intent: whole series removed, by SERVER-ISSUED key.
    p_excluded_series_keys text[],
    -- NULL on a first call; the digest a previous answer carried on every call after it.
    p_selection_digest     bytea,
    p_round_id             uuid,
    p_expected_version     int,
    p_label                text,
    p_target_start         date,
    p_target_end           date,
    p_term_weeks           int,
    p_priority_days        int,
    p_member_days          int,
    p_payment_mode         text,
    p_strict_mollie        boolean,
    p_public_open_mode     text,
    p_public_open_split    boolean,
    p_require_admin_review boolean,
    p_session_price        numeric,
    p_auto_reminder        boolean,
    p_reminder_lead_hours  int,
    p_invitation_subject   text,
    p_invitation_body      text,
    p_reminder_subject     text,
    p_reminder_body        text,
    p_rebook_rules         text,
    p_claim_info           text,
    p_holiday_from         date[],
    p_holiday_to           date[],
    p_holiday_label        text[],
    p_target_slot_ids      uuid[]
  ) RETURNS TABLE (
    row_kind                  text,
    -- ── 'result' ──
    status                    text,
    contract_version          text,
    review_fingerprint        bytea,
    apply_eligibility         text,
    selection_digest          bytea,
    child_count               int,
    source_count              int,
    cohort_total              int,
    occurrence_count          int,
    claim_count               int,
    holiday_row_count         int,
    exclusion_range_count     int,
    diagnostic_child          uuid,
    diagnostic_field          text,
    already_sent_groups       int,
    total_sessions            int,
    no_email_total            int,
    grand_invoice_total       numeric,
    source_term_weeks         int,
    source_modal_price        numeric,
    source_prices_include_vat boolean,
    -- ── 'series' ──
    series_key                text,
    child_cycle_id            uuid,
    series_excluded           boolean,
    target_name               text,
    local_weekday             int,
    local_time                time,
    trainer_id                uuid,
    trainer_name              text,
    location_id               uuid,
    location_name             text,
    max_participants          int,
    source_price              numeric,
    split_payment             boolean,
    prices_include_vat        boolean,
    subject_count             int,
    sessions                  int,
    invoice_total             numeric,
    no_email_count            int,
    -- ── 'roster' ──
    display_name              text,
    has_email                 boolean,
    -- ── 'result', D7 TERMINAL CLOSURE ──
    -- The round's current version, for `extend` only: the core's `expected_version` fence is
    -- mandatory and no client role can read `rebook_rounds`, so before this the browser had no
    -- way to state a premise the core would accept.
    round_version             int,
    -- When the contact snapshot below was taken. Contact data is a MUTABLE ATTRIBUTE, not command
    -- identity, so this is disclosed rather than frozen.
    roster_as_of              timestamptz
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $fn$
  DECLARE
    -- NOT INITIALIZED IN `DECLARE`: `auth.uid()` casts the JWT subject and RAISES on a malformed
    -- one, and a raise during DECLARE escapes before any gate has run — which would distinguish
    -- "malformed token" from "not authorized" and make this surface the oracle it must not be.
    v_actor    uuid;
    v_refuse   text;
    v_rv       int;            -- the round's current version (extend only)
    v_asof     timestamptz;    -- when this projection's contact snapshot was taken
    v_cands    uuid[];
    v_digest   bytea;
    v_label    text;
    v_zone     text;
    v_slots    uuid[];
    v_childs   uuid[];
    v_taken    text[];
    v_review   boolean := p_projection = 'review';
    -- Parallel per-series arrays, in the clusterer's deterministic order.
    v_k    text[];    v_exc boolean[]; v_lw  int[];     v_lt  time[];
    v_trn  uuid[];    v_loc uuid[];    v_pri numeric[]; v_spl boolean[];
    v_vat  boolean[]; v_max int[];     v_min int[];
    v_tnm  text[];    v_lnm text[];    v_ses int[];
    -- The INCLUDED subset, in the CORE's `child_cycle_id::text COLLATE "C"` order — the only
    -- inputs the naming chain may see, because they are the only children that will exist.
    v_inc_k     text[];  v_inc_lw int[];  v_inc_lt time[];  v_inc_names text[];
    v_sent int := 0;
    -- THE CORE'S ANSWER, IN SCALARS RATHER THAN A RECORD. A `record` that the `counts` path never
    -- assigns still RAISES when a `CASE WHEN v_review THEN v_core.status` is evaluated — plpgsql
    -- resolves the whole expression through SPI, so the CASE arm does not protect it. Scalars with
    -- explicit defaults make the two paths structurally different instead of conditionally so.
    v_status text := 'counted';
    v_fp     bytea;   v_elig text;
    v_cc     int := 0; v_sc int := 0; v_ct int := 0; v_oc int := 0; v_kc int := 0;
    v_hc     int := 0; v_ec int := 0;
    v_dc     uuid;    v_df   text;
  BEGIN
    -- ── THE GATES, AND ONE REFUSAL SHAPE ────────────────────────────────────────────────────
    --
    -- Authorization, the contract version and both closed vocabularies are decided together and
    -- BEFORE any product fact is resolved. There is exactly ONE place below that emits a refusal
    -- row, so "every refusal looks the same" is a property of the code's shape rather than a
    -- promise three copies of a row list have to keep.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      v_refuse := 'refused';
    ELSE
      BEGIN
        v_actor := auth.uid();
      EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
      END;
      IF v_actor IS NULL
         OR p_academy_profile_id IS NULL
         OR p_contract_version IS DISTINCT FROM 'abc27.wire.v1'
         OR p_command_kind IS NULL OR p_command_kind NOT IN ('create', 'extend')
         OR p_selection_mode IS NULL OR p_selection_mode NOT IN ('source_cycle', 'cohort')
         OR p_projection IS NULL OR p_projection NOT IN ('counts', 'review')
         -- REVIEW ROUND 4 (P1): A TARGET-BEARING REVIEW MUST ECHO A DIGEST.
         --
         -- This body is VOLATILE under READ COMMITTED and reads in several statements: the
         -- template facts the projection shows, the digest, and the core's derivation each take
         -- their own snapshot. The digest makes that FAIL CLOSED — but only for a caller that
         -- echoes one. A first call carrying minted target identities is the call that produces
         -- the send authority, and it could previously be made with no digest at all: a court
         -- repriced between the cached projection and the core would then return €25 on screen
         -- beside a fingerprint for €30, and applying those tokens wrote €30.
         --
         -- The PROBE (no targets) and the COUNT stay digest-free, because neither can arm
         -- anything: the probe exists precisely to obtain the digest the review then echoes.
         OR (p_projection = 'review'
             AND coalesce(array_length(p_target_slot_ids, 1), 0) > 0
             AND p_selection_digest IS NULL)
         OR NOT EXISTS (SELECT 1 FROM public.academy_managers am
                         WHERE am.academy_profile_id = p_academy_profile_id
                           AND am.user_id = v_actor) THEN
        v_refuse := 'refused';
      END IF;
    END IF;

    IF v_refuse IS NULL THEN
      -- ── THE CANDIDATE SET ─────────────────────────────────────────────────────────────────
      --
      -- NO EXISTENCE CHECK PRECEDES THIS, DELIBERATELY. Both candidate bridges re-anchor to the
      -- academy themselves, so a cycle that does not exist, a cycle belonging to another tenant
      -- and an empty cyclus all produce the SAME empty candidate array. Asking first would have
      -- been an existence oracle; not asking makes the three indistinguishable by construction.
      IF p_selection_mode = 'source_cycle' THEN
        v_cands := public.d7_p_cyclus_candidates(p_academy_profile_id, p_source_cycle_id);
      ELSE
        v_cands := public.d7_p_cohort_candidates(p_academy_profile_id, p_location_ids, p_term_end);
      END IF;

      -- The round's label and its taken names: the extend name chain matches the round's SENT
      -- names, and tier 4 skips suffixes any same-date rebook cycle already occupies.
      -- ── ONE NORMALIZATION, AT THE COMMAND BOUNDARY ──────────────────────────────────────
      --
      -- REVIEW ROUND 5 (P2): the projection used the RAW label while both cores use
      -- `rebook_round_sanitize_copy(p_label, 201)` (ABC-27 `:12947`). With `p_label = 'Ronde '`
      -- the review projected `Ronde  — Wo 09:00` and the apply wrote `Ronde — Wo 09:00`, and
      -- SUCCEEDED — the digest deliberately excludes the label, so nothing caught it. The shipped
      -- wizards trim at their body boundary, so this reached direct RPC callers only.
      --
      -- 201, NOT 200, AND THAT IS NOT AN OFF-BY-ONE. `rebook_rounds.label` carries
      -- `CHECK (… length(label) <= 200)`, so sanitizing to max+1 lets a 201-character label FAIL
      -- that constraint instead of being silently truncated into a legal 200. The refusal below
      -- turns that into a typed answer at the surface rather than a constraint violation deep
      -- inside the writer.
      v_label := public.rebook_round_sanitize_copy(
                   coalesce(public.d7_p_round_label(p_academy_profile_id,
                              CASE WHEN p_command_kind = 'extend' THEN p_round_id END), p_label), 201);
      IF v_label IS NULL OR length(v_label) > 200 THEN
        v_refuse := 'invalid_request';
      END IF;
    END IF;

    IF v_refuse IS NULL THEN
      -- ── THE ROUND'S CURRENT VERSION, FOR `extend` ───────────────────────────────────────
      --
      -- OWNER DECISION `OD3_DISCLOSE_ACADEMY_SCOPED_ROUND_VERSION_FOR_EXTEND`. This wrapper is
      -- Domain-A-owned and SECURITY DEFINER, so it can read the A-owned `rebook_rounds` that is
      -- revoked from every client role. NO NEW GRANT IS MADE: one integer about the caller's own
      -- round reaches a manager already proven for this academy, and the table stays revoked.
      --
      -- The fence is unweakened — this is ordinary optimistic concurrency. The caller reads v,
      -- applies with expected v, and a concurrent extend still yields the core's typed
      -- `expected_version_mismatch`. Digesting it as well (see `d7_p_selection_digest`) simply
      -- moves the friendlier `selection_moved` in front of it.
      IF p_command_kind = 'extend' THEN
        SELECT r.version INTO v_rv
          FROM public.rebook_rounds r
         WHERE r.id = p_round_id AND r.academy_profile_id = p_academy_profile_id;
      END IF;
      v_asof := clock_timestamp();
      v_zone  := public.d7_p_academy_timezone(p_academy_profile_id);
      SELECT coalesce(array_agg(DISTINCT n.name), ARRAY[]::text[]) INTO v_taken
        FROM public.d7_p_round_taken_names(p_academy_profile_id,
               CASE WHEN p_command_kind = 'extend' THEN p_round_id END, p_target_start) n;

      -- ── THE SERIES, ONCE, INTO PARALLEL ARRAYS ────────────────────────────────────────────
      --
      -- Extend suppression is the ROUND's, and a create's round owns no cycles, so passing it on
      -- a create would be a no-op filter; NULL says so outright rather than depending on that
      -- emptiness — which is not guaranteed when an operator retries a create with the same
      -- client-minted round uuid.
      SELECT array_agg(x.skey ORDER BY x.o, x.skey), array_agg(x.exc ORDER BY x.o, x.skey),
             array_agg(x.lw ORDER BY x.o, x.skey),   array_agg(x.lt ORDER BY x.o, x.skey),
             array_agg(x.trn ORDER BY x.o, x.skey),  array_agg(x.loc ORDER BY x.o, x.skey),
             array_agg(x.pri ORDER BY x.o, x.skey),  array_agg(x.spl ORDER BY x.o, x.skey),
             array_agg(x.vat ORDER BY x.o, x.skey),  array_agg(x.mx ORDER BY x.o, x.skey),
             array_agg(x.mn ORDER BY x.o, x.skey)
        INTO v_k, v_exc, v_lw, v_lt, v_trn, v_loc, v_pri, v_spl, v_vat, v_max, v_min
        FROM (
          SELECT c.series_key AS skey, bool_or(c.excluded) AS exc,
                 min(c.local_weekday) AS lw, min(c.local_time) AS lt,
                 -- `min(uuid)` DOES NOT EXIST. Every row of a series carries the same trainer
                 -- and location by construction — both are part of the cluster key — so the
                 -- first by the clusterer's own order is the series' value.
                 (array_agg(c.trainer_id  ORDER BY c.slot_start, c.slot_id))[1] AS trn,
                 (array_agg(c.location_id ORDER BY c.slot_start, c.slot_id))[1] AS loc,
                 min(c.tmpl_price) AS pri, bool_or(c.tmpl_split) AS spl,
                 bool_or(c.tmpl_vat) AS vat, min(c.tmpl_max) AS mx, min(c.tmpl_minutes) AS mn,
                 min(c.series_first) AS o
            FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode,
                   p_term_end, CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
                   v_label, p_excluded_series_keys) c
           WHERE c.qualifies AND NOT c.suppressed
           GROUP BY c.series_key
        ) x;
      v_k   := coalesce(v_k,   ARRAY[]::text[]);
      v_exc := coalesce(v_exc, ARRAY[]::boolean[]);

      SELECT count(DISTINCT c.series_key)::int INTO v_sent
        FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
               CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
               v_label, p_excluded_series_keys) c
       WHERE c.qualifies AND c.suppressed;

      -- ── THE DIGEST, OVER EVERYTHING THE ANSWER IS A FUNCTION OF ───────────────────────────
      --
      -- Taken over the qualifying, unsuppressed rows BEFORE exclusion, because the keys the caller
      -- echoes were issued from that set and must be judged against it — not against the set they
      -- already reduced.
      --
      -- REVIEW ROUND 1 (P1): IT COVERS MORE THAN THE (series, slot) PAIRS NOW, and the reason is
      -- that this wrapper is VOLATILE under READ COMMITTED and issues its reads as SEPARATE
      -- statements — so each one takes its own snapshot. The first version digested only the
      -- series keys and slot ids, which left two ways for the operator to approve something other
      -- than what would be written:
      --
      --   • a same-date rebook cycle committing between this wrapper's taken-name read and the
      --     core's own one: the screen shows `Ronde — Wo 09:00`, the fingerprint binds the newly
      --     disambiguated `… #2`, and the apply SUCCEEDS with the name nobody reviewed;
      --   • a source court's price or capacity changing between the projection read and the core's
      --     derivation: the review shows one invoice projection and the round is built from
      --     another.
      --
      -- Adding the template facts and the taken-name set makes the digest a real source-state
      -- digest: either of those moves it, and the apply — which recomputes it — answers
      -- `selection_moved` instead of writing an unreviewed round. It does NOT make the read
      -- atomic; it makes a non-atomic read fail closed, which is the property that matters.
      v_digest := public.d7_p_selection_digest(
        p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
        CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
        v_label, p_excluded_series_keys, p_target_start, v_rv);

      IF p_selection_digest IS NOT NULL AND p_selection_digest IS DISTINCT FROM v_digest THEN
        v_refuse := 'selection_moved';
      END IF;
    END IF;

    IF v_refuse IS NOT NULL THEN
      RETURN QUERY SELECT 'result'::text, v_refuse, p_contract_version,
        NULL::bytea, NULL::text,
        -- The digest is withheld on a refusal too: a caller that was not allowed to ask learns
        -- nothing about the selection, including whether it moved.
        NULL::bytea,
        NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int,
        NULL::uuid, NULL::text, NULL::int, NULL::int, NULL::int, NULL::numeric,
        NULL::int, NULL::numeric, NULL::boolean,
        NULL::text, NULL::uuid, NULL::boolean, NULL::text, NULL::int, NULL::time,
        NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::int, NULL::numeric,
        NULL::boolean, NULL::boolean, NULL::int, NULL::int, NULL::numeric, NULL::int,
        NULL::text, NULL::boolean,
        NULL::int, NULL::timestamptz;
      RETURN;
    END IF;

    -- ── THE FINAL SOURCE ARRAYS AND THE DERIVED CHILD IDENTITIES ────────────────────────────
    --
    -- Derived, never minted: `md5(round || '|' || key)`. Stable across the probe, the review and
    -- the apply, so the reviewed fingerprint survives the round trip; keyed on the CLIENT-minted
    -- round uuid, so two rounds built from the same sources never collide on a child id.
    SELECT array_agg(c.slot_id ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id),
           array_agg(public.d7_child_cycle_id(p_round_id, c.series_key)
                     ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id)
      INTO v_slots, v_childs
      FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
             CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
             v_label, p_excluded_series_keys) c
     WHERE c.qualifies AND NOT c.suppressed AND NOT c.excluded;
    v_slots  := coalesce(v_slots,  ARRAY[]::uuid[]);
    v_childs := coalesce(v_childs, ARRAY[]::uuid[]);

    -- ── DISPLAY NAMES, THEN THE HUMAN-READABLE CHILD NAMES ──────────────────────────────────
    --
    -- REVIEW ROUND 1 (P1): THESE MUST BE THE CORE'S CHILDREN, IN THE CORE'S ORDER. The first
    -- version named every qualifying unsuppressed series — INCLUDING the excluded ones — while the
    -- core only ever sees the included subset and names it ordered by `child_cycle_id::text
    -- COLLATE "C"`. With two series and one exclusion the review showed `Ronde — Wo 09:00` for a
    -- child the core named bare `Ronde`, because the chain's tier-0 "one series keeps the label
    -- verbatim" arm fires for the core and not for the projection. Numeric suffixes could land on
    -- a different series for the same reason. The operator approved a name nothing would write,
    -- and the apply succeeded, so nothing caught it.
    --
    -- The naming inputs are therefore built from the INCLUDED set, in the child-id order the core
    -- uses, and an excluded series gets NO name — it has no child, so a name for it would be a
    -- second fiction.
    --
    -- A trainer's display name lives on their PROFILE and is used FIRST NAME ONLY, exactly as the
    -- legacy chain used it.
    -- The INCLUDED series, in the core's child-id order.
    SELECT array_agg(z.k ORDER BY z.cid), array_agg(z.lw ORDER BY z.cid),
           array_agg(z.lt ORDER BY z.cid),
           array_agg((SELECT split_part(d.display_name, ' ', 1)
                        FROM public.d7_p_display_names(v_trn, v_loc) d
                       WHERE d.kind = 'trainer' AND d.subject_id = z.trn) ORDER BY z.cid),
           array_agg((SELECT d.display_name
                        FROM public.d7_p_display_names(v_trn, v_loc) d
                       WHERE d.kind = 'location' AND d.subject_id = z.loc) ORDER BY z.cid)
      INTO v_inc_k, v_inc_lw, v_inc_lt, v_tnm, v_lnm
      FROM (
        SELECT v_k[u.i] AS k, v_lw[u.i] AS lw, v_lt[u.i] AS lt,
               v_trn[u.i] AS trn, v_loc[u.i] AS loc,
               (public.d7_child_cycle_id(p_round_id, v_k[u.i]))::text COLLATE "C" AS cid
          FROM generate_series(1, coalesce(array_length(v_k, 1), 0)) AS u(i)
         WHERE NOT coalesce(v_exc[u.i], false)
      ) z;
    v_inc_k  := coalesce(v_inc_k,  ARRAY[]::text[]);
    v_inc_lw := coalesce(v_inc_lw, ARRAY[]::int[]);
    v_inc_lt := coalesce(v_inc_lt, ARRAY[]::time[]);
    v_tnm    := coalesce(v_tnm,    ARRAY[]::text[]);
    v_lnm    := coalesce(v_lnm,    ARRAY[]::text[]);
    -- SANITIZED TO THE SAME 300 CHARACTERS THE CORE STORES.
    --
    -- REVIEW ROUND 3 (P1): the cores end their naming with
    -- `rebook_round_sanitize_copy(…, 300)` and fingerprint the TRUNCATED value; the projection
    -- returned the untruncated one. A 200-character label plus a long trainer name on two
    -- same-time series is over 300 characters, so the operator approved one name and a different,
    -- shorter one was written — with the fingerprint agreeing, because it was taken over what the
    -- core produced.
    SELECT array_agg(public.rebook_round_sanitize_copy(n, 300) ORDER BY i)
      INTO v_inc_names
      FROM unnest(public.d7_child_target_names(coalesce(v_label, ''), v_inc_k, v_inc_lw, v_inc_lt,
                                               v_tnm, v_lnm, v_taken)) WITH ORDINALITY AS u(n, i);
    v_inc_names := coalesce(v_inc_names, ARRAY[]::text[]);

    -- Per-series session counts, from the SAME generator the typed core previews with.
    SELECT array_agg(s.n ORDER BY s.i) INTO v_ses
      FROM (SELECT u.i,
                   CASE WHEN v_review THEN public.d7_series_session_count(
                     v_zone, p_target_start, v_lw[u.i], v_lt[u.i], v_min[u.i],
                     p_term_weeks, p_target_end, p_holiday_from, p_holiday_to) END AS n
              FROM generate_series(1, coalesce(array_length(v_k, 1), 0)) AS u(i)) s;
    v_ses := coalesce(v_ses, ARRAY[]::int[]);

    -- ── THE TYPED VERDICT, FOR `review` ONLY ────────────────────────────────────────────────
    IF v_review THEN
      SELECT core.status, core.review_fingerprint, core.apply_eligibility, core.child_count,
             core.source_count, core.cohort_total, core.occurrence_count, core.claim_count,
             core.holiday_row_count, core.exclusion_range_count, core.diagnostic_child,
             core.diagnostic_field
        INTO v_status, v_fp, v_elig, v_cc, v_sc, v_ct, v_oc, v_kc, v_hc, v_ec, v_dc, v_df
        FROM public.rebook_round_preview_normalized_core(
        v_actor, p_academy_profile_id, p_contract_version, p_command_kind, p_round_id,
        p_expected_version, p_label, p_target_start, p_target_end, p_term_weeks,
        p_priority_days, p_member_days, p_payment_mode, p_strict_mollie,
        p_public_open_mode, p_public_open_split, p_require_admin_review, p_session_price,
        p_auto_reminder, p_reminder_lead_hours, p_invitation_subject, p_invitation_body,
        p_reminder_subject, p_reminder_body, p_rebook_rules, p_claim_info,
        p_holiday_from, p_holiday_to, p_holiday_label,
        v_slots, v_childs, p_target_slot_ids) core;

      -- ── ZERO OCCURRENCES IS NOT A PREVIEW ─────────────────────────────────────────────
      --
      -- REVIEW ROUND 5 (P2): the frozen preview verdict has no `n_occ > 0` arm, so a coherent
      -- selection whose every occurrence is removed by the holiday windows came back `previewed`
      -- WITH A FINGERPRINT — and the apply writer then raised a bare `22023` (ABC-27 `:14164`),
      -- outside the typed vocabulary entirely. The browser refuses it first, so this stranded
      -- direct RPC callers: a reviewed fingerprint that can never produce a typed apply result.
      --
      -- The refusal is issued HERE, at the D7 surface, because ABC-27 is frozen. `invalid_request`
      -- is already in the 19-value status vocabulary, so no decoder changes shape.
      --
      -- NOTHING ARMABLE IS ISSUED: the fingerprint AND the digest are withheld, so there is no
      -- token an apply could be attempted with.
      IF v_status = 'previewed' AND coalesce(v_oc, 0) = 0 THEN
        v_status := 'invalid_request';
        v_fp     := NULL;
        v_elig   := NULL;
        v_digest := NULL;
        v_df     := 'occurrences';
      END IF;
    ELSE
      -- The counting path answers from the DERIVATION alone, which is the whole reason it exists:
      -- the typed core cannot judge an intent that carries no length and no label.
      -- REVIEW ROUND 1 (P2): the INCLUDED count. `v_k` carries every qualifying series, excluded
      -- ones included, so `array_length(v_k)` reported two children beside a cohort total and a
      -- source count that described one.
      SELECT count(*)::int INTO v_cc
        FROM generate_series(1, coalesce(array_length(v_k, 1), 0)) AS u(i)
       WHERE NOT coalesce(v_exc[u.i], false);
      v_sc := coalesce(array_length(v_slots, 1), 0);
      SELECT count(DISTINCT d.recipient_key)::int INTO v_ct
        FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
               CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
               v_label, p_excluded_series_keys) c
        JOIN public.d7_p_subject_display(p_academy_profile_id, v_cands) d ON d.slot_id = c.slot_id
       WHERE c.qualifies AND NOT c.suppressed AND NOT c.excluded;
      v_ct := coalesce(v_ct, 0);
    END IF;

    -- ── THE RESULT ROW ──────────────────────────────────────────────────────────────────────
    RETURN QUERY
    WITH subj AS (
      SELECT c.series_key AS k, d.recipient_key AS rk, bool_or(d.has_email) AS has_email
        FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
               CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
               v_label, p_excluded_series_keys) c
        JOIN public.d7_p_subject_display(p_academy_profile_id, v_cands) d ON d.slot_id = c.slot_id
       WHERE c.qualifies AND NOT c.suppressed
       GROUP BY c.series_key, d.recipient_key
    ),
    idx AS (SELECT u.i FROM generate_series(1, coalesce(array_length(v_k, 1), 0)) AS u(i))
    SELECT 'result'::text,
           v_status, p_contract_version, v_fp, v_elig, v_digest,
           -- The distinct headcount counts a person ONCE across the INCLUDED series, which is
           -- exactly why it cannot be re-summed from the per-series counts client-side.
           v_cc, v_sc, v_ct, v_oc, v_kc, v_hc, v_ec, v_dc, v_df,
           v_sent,
           -- The three review totals are over the INCLUDED series only, as the legacy review is.
           CASE WHEN v_review THEN (
             SELECT coalesce(sum(coalesce(v_ses[i.i], 0)
                                 * (SELECT count(*)::int FROM subj s WHERE s.k = v_k[i.i])), 0)::int
               FROM idx i WHERE NOT coalesce(v_exc[i.i], false)) END,
           CASE WHEN v_review THEN (
             SELECT coalesce(sum((SELECT count(*)::int FROM subj s
                                   WHERE s.k = v_k[i.i] AND NOT s.has_email)), 0)::int
               FROM idx i WHERE NOT coalesce(v_exc[i.i], false)) END,
           CASE WHEN v_review THEN (
             SELECT coalesce(sum(coalesce(p_session_price, v_pri[i.i]) * coalesce(v_ses[i.i], 0)), 0)::numeric
               FROM idx i WHERE NOT coalesce(v_exc[i.i], false)
                 AND coalesce(p_session_price, v_pri[i.i]) IS NOT NULL) END,
           -- THE SOURCE TERM RECOMMENDATION. `LENGTH=THE_PROJECTION_MAY_DISPLAY_A_SOURCE_TERM
           -- _RECOMMENDATION_BUT_THE_MANAGER_MUST_EXPLICITLY_CHOOSE_THE_LENGTH`: these DESCRIBE
           -- the term that ran. Nothing here substitutes them into an intent — a missing length is
           -- still the typed core's refusal, which is what `SERVER=NO_IMPLICIT_LENGTH
           -- _SUBSTITUTION_AND_MISSING_LENGTH_REMAINS_A_TYPED_REFUSAL` requires.
           (SELECT max(w.n)::int FROM (
              SELECT count(DISTINCT floor(extract(epoch FROM c.slot_start) / 604800))::int AS n
                FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode,
                       p_term_end, CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
                       v_label, p_excluded_series_keys) c
               WHERE c.qualifies AND NOT c.suppressed
               GROUP BY c.series_key) w),
           -- REVIEW ROUND 1 (P2): OVER SLOTS, NOT OVER SERIES. The legacy suggestion is the mode of
           -- `qualifyingSeries.flat().map(price)` — every slot — so a ten-session €30 series beside
           -- two one-session €20 series suggests €30. Taking one template price per series made it
           -- €20, which is a different number on the operator's screen for the same source term.
           (SELECT mode() WITHIN GROUP (ORDER BY c.tmpl_price)
              FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode,
                     p_term_end, CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
                     v_label, p_excluded_series_keys) c
             WHERE c.qualifies AND NOT c.suppressed AND c.tmpl_price IS NOT NULL),
           (SELECT CASE WHEN count(*) = 0 THEN NULL
                        ELSE count(*) FILTER (WHERE z.v) >= count(*) - count(*) FILTER (WHERE z.v) END
              FROM unnest(v_vat) AS z(v)),
           NULL::text, NULL::uuid, NULL::boolean, NULL::text, NULL::int, NULL::time,
           NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::int, NULL::numeric,
           NULL::boolean, NULL::boolean, NULL::int, NULL::int, NULL::numeric, NULL::int,
           NULL::text, NULL::boolean,
           v_rv, v_asof;

    -- ── ONE ROW PER SERIES ──────────────────────────────────────────────────────────────────
    --
    -- EVERY qualifying series, excluded ones INCLUDED and flagged: the operator's checklist is
    -- built from this, so a series that vanished the moment it was unticked could never be put
    -- back.
    RETURN QUERY
    WITH names AS (SELECT d.kind, d.subject_id, d.display_name
                     FROM public.d7_p_display_names(v_trn, v_loc) d),
    subj AS (
      SELECT c.series_key AS k, d.recipient_key AS rk, bool_or(d.has_email) AS has_email
        FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
               CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
               v_label, p_excluded_series_keys) c
        JOIN public.d7_p_subject_display(p_academy_profile_id, v_cands) d ON d.slot_id = c.slot_id
       WHERE c.qualifies AND NOT c.suppressed
       GROUP BY c.series_key, d.recipient_key
    )
    SELECT 'series'::text,
           NULL::text, p_contract_version, NULL::bytea, NULL::text, NULL::bytea,
           NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int,
           NULL::uuid, NULL::text, NULL::int, NULL::int, NULL::int, NULL::numeric,
           NULL::int, NULL::numeric, NULL::boolean,
           v_k[u.i],
           public.d7_child_cycle_id(p_round_id, v_k[u.i]),
           coalesce(v_exc[u.i], false),
           -- NULL for an excluded series: it has no child, so it has no name.
           CASE WHEN coalesce(v_exc[u.i], false) THEN NULL
                ELSE v_inc_names[array_position(v_inc_k, v_k[u.i])] END,
           v_lw[u.i], v_lt[u.i],
           v_trn[u.i],
           (SELECT n.display_name FROM names n WHERE n.kind = 'trainer' AND n.subject_id = v_trn[u.i]),
           v_loc[u.i],
           (SELECT n.display_name FROM names n WHERE n.kind = 'location' AND n.subject_id = v_loc[u.i]),
           v_max[u.i], v_pri[u.i], v_spl[u.i], v_vat[u.i],
           (SELECT count(*)::int FROM subj s WHERE s.k = v_k[u.i]),
           v_ses[u.i],
           CASE WHEN v_review AND coalesce(p_session_price, v_pri[u.i]) IS NOT NULL
                THEN coalesce(p_session_price, v_pri[u.i]) * coalesce(v_ses[u.i], 0) END,
           (SELECT count(*)::int FROM subj s WHERE s.k = v_k[u.i] AND NOT s.has_email),
           NULL::text, NULL::boolean,
           NULL::int, NULL::timestamptz
      FROM generate_series(1, coalesce(array_length(v_k, 1), 0)) AS u(i)
     ORDER BY u.i;

    -- ── THE ROSTER, `review` ONLY ───────────────────────────────────────────────────────────
    IF v_review THEN
      RETURN QUERY
      SELECT 'roster'::text,
             NULL::text, p_contract_version, NULL::bytea, NULL::text, NULL::bytea,
             NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, NULL::int,
             NULL::uuid, NULL::text, NULL::int, NULL::int, NULL::int, NULL::numeric,
             NULL::int, NULL::numeric, NULL::boolean,
             r.k, NULL::uuid, NULL::boolean, NULL::text, NULL::int, NULL::time,
             NULL::uuid, NULL::text, NULL::uuid, NULL::text, NULL::int, NULL::numeric,
             NULL::boolean, NULL::boolean, NULL::int, NULL::int, NULL::numeric, NULL::int,
             r.display_name, r.has_email,
             NULL::int, NULL::timestamptz
        FROM (
          SELECT c.series_key AS k, d.recipient_key AS rk,
                 min(d.display_name) AS display_name, bool_or(d.has_email) AS has_email
            FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode,
                   p_term_end, CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
                   v_label, p_excluded_series_keys) c
            JOIN public.d7_p_subject_display(p_academy_profile_id, v_cands) d ON d.slot_id = c.slot_id
           WHERE c.qualifies AND NOT c.suppressed
           GROUP BY c.series_key, d.recipient_key
        ) r
       ORDER BY r.k, r.display_name, r.rk;
    END IF;
  END;
  $fn$;

  EXECUTE format('ALTER FUNCTION public.rebook_round_selection_preview_as_actor(uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[]) OWNER TO %I', v_a);
  REVOKE ALL ON FUNCTION public.rebook_round_selection_preview_as_actor(uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.rebook_round_selection_preview_as_actor(uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[])
    TO authenticated;

  -- ── (3) THE APPLY SURFACE ─────────────────────────────────────────────────────────────────
  DROP FUNCTION public.rebook_round_selection_apply_as_actor(uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],bytea);
  CREATE FUNCTION public.rebook_round_selection_apply_as_actor(
    p_academy_profile_id   uuid,
    p_command_id           uuid,
    p_contract_version     text,
    p_command_kind         text,
    p_selection_mode       text,
    p_source_cycle_id      uuid,
    p_location_ids         uuid[],
    p_term_end             date,
    p_excluded_series_keys text[],
    -- MANDATORY HERE, unlike on the preview surface. An apply that did not name the selection it
    -- was reviewed against could be applied from a selection the operator never saw; the preview
    -- may be asked without one because asking is not acting.
    p_selection_digest     bytea,
    p_round_id             uuid,
    p_expected_version     int,
    p_label                text,
    p_target_start         date,
    p_target_end           date,
    p_term_weeks           int,
    p_priority_days        int,
    p_member_days          int,
    p_payment_mode         text,
    p_strict_mollie        boolean,
    p_public_open_mode     text,
    p_public_open_split    boolean,
    p_require_admin_review boolean,
    p_session_price        numeric,
    p_auto_reminder        boolean,
    p_reminder_lead_hours  int,
    p_invitation_subject   text,
    p_invitation_body      text,
    p_reminder_subject     text,
    p_reminder_body        text,
    p_rebook_rules         text,
    p_claim_info           text,
    p_holiday_from         date[],
    p_holiday_to           date[],
    p_holiday_label        text[],
    p_target_slot_ids      uuid[],
    p_review_fingerprint   bytea
  ) RETURNS TABLE (
    status            text,
    round_id          uuid,
    command_id        uuid,
    child_count       int,
    occurrence_count  int,
    claim_count       int,
    receipt_canonical bytea,
    receipt_digest    bytea,
    detail            jsonb,
    round_version     int,
    -- THE ROUND'S OWN CHILDREN, returned so the caller can drain invites for them.
    --
    -- This is NOT the source array the client rule withholds. These are the cycles this command
    -- just created — rows the operator is about to be shown and navigate into — and the caller
    -- needs them to drain. The alternative was for the browser to re-derive
    -- `md5(round || '|' || series_key)` for itself, which is the browser reproducing a server
    -- derivation: the exact habit this release exists to end.
    child_cycle_ids   uuid[],
    -- ── D7 TERMINAL CLOSURE · CONTACT DISCLOSURE ──
    --
    -- OWNER DECISION `OD1_MUTABLE_CONTACTS_AND_TIMESTAMPED_DISCLOSURE` /
    -- `OD2_PROCEED_ON_CONTACT_DELTA_AND_DISCLOSE_AT_APPLY_AND_SEND`.
    --
    -- Contact data is a mutable attribute of a person, not identity of a command, so the apply
    -- PROCEEDS when it has moved. What it must not do is stay quiet about it. These are the
    -- CURRENT counts over the included series, at apply time.
    --
    -- The server states a fact; it does not compare. The caller already holds the reviewed
    -- projection the operator approved, so the arithmetic between two SERVER-ISSUED numbers is
    -- the caller's — which is why no client-supplied baseline is accepted here. A baseline the
    -- browser passed would be the browser deciding what it had been told.
    contactable_count   int,
    uncontactable_count int
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $fn$
  DECLARE
    -- NOT INITIALIZED IN `DECLARE`, for the reason every wrapper in this family records: a
    -- malformed subject would raise before any gate and turn authorization into a distinguishable
    -- error.
    v_actor  uuid;
    v_refuse boolean := false;
    v_cands  uuid[];
    v_label  text;
    v_digest bytea;
    v_replay boolean := false;
    v_rv     int;   -- the round's current version, for the digest (extend only)
    v_con    int;   -- recipients reachable NOW, over the included series
    v_unc    int;   -- recipients not reachable NOW
    v_occ    int;   -- occurrences this selection derives
    v_slots  uuid[];
    v_childs uuid[];
    v_row    record;
  BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      v_refuse := true;
    ELSE
      BEGIN
        v_actor := auth.uid();
      EXCEPTION WHEN OTHERS THEN
        v_actor := NULL;
      END;
      IF v_actor IS NULL
         OR p_academy_profile_id IS NULL
         OR p_command_id IS NULL
         OR p_contract_version IS DISTINCT FROM 'abc27.wire.v1'
         OR p_command_kind IS NULL OR p_command_kind NOT IN ('create', 'extend')
         OR p_selection_mode IS NULL OR p_selection_mode NOT IN ('source_cycle', 'cohort')
         OR p_selection_digest IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.academy_managers am
                         WHERE am.academy_profile_id = p_academy_profile_id
                           AND am.user_id = v_actor) THEN
        v_refuse := true;
      END IF;
    END IF;
    IF v_refuse THEN
      RETURN QUERY SELECT 'refused'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea, NULL::jsonb, NULL::int, NULL::uuid[],
                          NULL::int, NULL::int;
      RETURN;
    END IF;

    IF p_selection_mode = 'source_cycle' THEN
      v_cands := public.d7_p_cyclus_candidates(p_academy_profile_id, p_source_cycle_id);
    ELSE
      v_cands := public.d7_p_cohort_candidates(p_academy_profile_id, p_location_ids, p_term_end);
    END IF;
    -- THE SAME ONE NORMALIZATION THE PREVIEW APPLIES, with the same constant. Two surfaces that
    -- normalize a naming input differently is the defect class that produced the round-1 digest
    -- drift; `201` is max+1 so a 201-character label fails `rebook_rounds`' own CHECK rather than
    -- being silently truncated to a legal 200.
    v_label := public.rebook_round_sanitize_copy(
                 coalesce(public.d7_p_round_label(p_academy_profile_id,
                            CASE WHEN p_command_kind = 'extend' THEN p_round_id END), p_label), 201);
    IF v_label IS NULL OR length(v_label) > 200 THEN
      RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea,
                          jsonb_build_object('field', 'label',
                            'reason', 'the label is empty or longer than the 200 characters a round may carry'),
                          NULL::int, NULL::uuid[], NULL::int, NULL::int;
      RETURN;
    END IF;

    -- The round's current version, so the digest below is taken over the same premise the preview
    -- digested. Domain-A-owned body reading an A-owned table; no grant is involved.
    IF p_command_kind = 'extend' THEN
      SELECT r.version INTO v_rv
        FROM public.rebook_rounds r
       WHERE r.id = p_round_id AND r.academy_profile_id = p_academy_profile_id;
    END IF;

    -- ── A REPLAY IS ANSWERED BEFORE THE SELECTION IS FENCED ─────────────────────────────────
    --
    -- REVIEW ROUND 1 (P1). THE FENCE MADE A COMMITTED COMMAND UNREPLAYABLE, and it did so for the
    -- ordinary success case, not an exotic one: applying a round CREATES cycles, those cycles are
    -- same-date rebook cycles of this academy, and the digest covers the round's taken names — so
    -- the very act of succeeding changes the digest. An extend is worse still: its new children
    -- are stamped with the source cyclus, so the clusterer then suppresses those series and the
    -- (series, slot) half moves as well. Either way the retry after a lost response was refused
    -- `selection_moved` and never reached the core's stored receipt, which is precisely the
    -- situation the command uuid exists to resolve.
    --
    -- So a command this actor has ALREADY COMMITTED under this exact fingerprint goes straight to
    -- the core, which answers it from its stored bytes without issuing a capability or entering
    -- Domain P. Anything else — an unknown command, another actor's, another academy's, or the
    -- same uuid with a different review — is fenced normally and then answered by the core in its
    -- own vocabulary (`command_tenant_mismatch`, `command_payload_mismatch`). This reads only the
    -- Domain-A command table, scoped to the caller, so it discloses nothing a replay would not.
    SELECT EXISTS (
      SELECT 1 FROM public.rebook_round_commands rc
       WHERE rc.command_id = p_command_id
         AND rc.academy_profile_id = p_academy_profile_id
         AND rc.actor_user_id IS NOT DISTINCT FROM v_actor
         AND rc.request_fingerprint = p_review_fingerprint)
      INTO v_replay;

    -- THE SELECTION IS FENCED BEFORE THE COMMAND IS. A selection that moved is the operator's
    -- question, answered in the selection's own words; a source that moved underneath an unchanged
    -- selection is the core's, answered as `source_drift`. Collapsing the two would report a
    -- re-selected round as a data race.
    v_digest := public.d7_p_selection_digest(
      p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
      CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
      v_label, p_excluded_series_keys, p_target_start, v_rv);
    IF NOT v_replay AND p_selection_digest IS DISTINCT FROM v_digest THEN
      RETURN QUERY SELECT 'selection_moved'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea, NULL::jsonb, NULL::int, NULL::uuid[],
                          NULL::int, NULL::int;
      RETURN;
    END IF;

    SELECT array_agg(c.slot_id ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id),
           array_agg(public.d7_child_cycle_id(p_round_id, c.series_key)
                     ORDER BY c.series_first, c.series_key, c.slot_start, c.slot_id)
      INTO v_slots, v_childs
      FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode, p_term_end,
             CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
             v_label, p_excluded_series_keys) c
     WHERE c.qualifies AND NOT c.suppressed AND NOT c.excluded;

    -- ── ZERO OCCURRENCES REFUSES IN THE TYPED VOCABULARY ──────────────────────────────────
    --
    -- The frozen writer raises a bare `22023` for an empty child or slot set (ABC-27 `:14164`),
    -- which escapes the closed envelope as a raw SQLSTATE. A replay is exempt: it is answered
    -- from stored bytes and never re-derives, so refusing one here would break the very recovery
    -- the command uuid exists for.
    v_occ := coalesce(array_length(v_slots, 1), 0);
    IF NOT v_replay AND (v_occ = 0 OR coalesce(array_length(v_childs, 1), 0) = 0) THEN
      RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, p_command_id, 0, 0, 0,
                          NULL::bytea, NULL::bytea,
                          jsonb_build_object('field', 'occurrences',
                            'reason', 'this selection derives no occurrence to rebook'),
                          NULL::int, NULL::uuid[], NULL::int, NULL::int;
      RETURN;
    END IF;

    -- ── THE CONTACT SNAPSHOT, AS OF NOW ───────────────────────────────────────────────────
    --
    -- Taken over the INCLUDED series, one row per recipient key, exactly as the review's
    -- `subject_count` / `no_email_count` are. `bool_or(has_email)` matches the review's own
    -- aggregation, so the two numbers are commensurable — which is the whole point of returning
    -- them rather than a delta the server would have to guess a baseline for.
    SELECT count(*) FILTER (WHERE s.has_email)::int,
           count(*) FILTER (WHERE NOT s.has_email)::int
      INTO v_con, v_unc
      FROM (
        SELECT bool_or(d.has_email) AS has_email
          FROM public.d7_p_series_cluster(p_academy_profile_id, v_cands, p_selection_mode,
                 p_term_end, CASE WHEN p_command_kind = 'extend' THEN p_round_id END,
                 v_label, p_excluded_series_keys) c
          JOIN public.d7_p_subject_display(p_academy_profile_id, v_cands) d ON d.slot_id = c.slot_id
         WHERE c.qualifies AND NOT c.suppressed AND NOT c.excluded
         GROUP BY c.series_key, d.recipient_key) s;

    -- A PURE PASS-THROUGH of the core's answer, exactly as the wrapper it mirrors is: the core is
    -- the sole actor-bound receipt authority, so nothing here performs a second command lookup
    -- that could disclose a peer actor's stored receipt.
    SELECT * INTO v_row FROM public.rebook_round_apply_normalized_core(
      v_actor, p_academy_profile_id, p_contract_version, p_command_kind, p_command_id, p_round_id,
      p_expected_version, p_label, p_target_start, p_target_end, p_term_weeks,
      p_priority_days, p_member_days, p_payment_mode, p_strict_mollie,
      p_public_open_mode, p_public_open_split, p_require_admin_review, p_session_price,
      p_auto_reminder, p_reminder_lead_hours, p_invitation_subject, p_invitation_body,
      p_reminder_subject, p_reminder_body, p_rebook_rules, p_claim_info,
      p_holiday_from, p_holiday_to, p_holiday_label,
      coalesce(v_slots, ARRAY[]::uuid[]), coalesce(v_childs, ARRAY[]::uuid[]),
      p_target_slot_ids, p_review_fingerprint);

    RETURN QUERY SELECT v_row.status, v_row.round_id, v_row.command_id,
                        v_row.child_count, v_row.occurrence_count, v_row.claim_count,
                        v_row.receipt_canonical, v_row.receipt_digest, v_row.detail,
                        v_row.round_version,
                        -- Only on an outcome that HAS children: a refusal discloses nothing.
                        -- REVIEW ROUND 1 (P3): ORDERED. `array_agg(DISTINCT …)` without an
                        -- ORDER BY leaves the order to the planner, so a replay could pick a
                        -- different first navigation target and a different drain order than the
                        -- original apply — the same command answering differently twice.
                        CASE WHEN v_row.status IN ('applied', 'replayed')
                             THEN (SELECT array_agg(DISTINCT ch ORDER BY ch)
                                     FROM unnest(v_childs) ch) END,
                        -- Disclosed only on an outcome that WROTE something. A refusal says
                        -- nothing about who is reachable, for the same reason it discloses no
                        -- child ids.
                        CASE WHEN v_row.status IN ('applied', 'replayed') THEN v_con END,
                        CASE WHEN v_row.status IN ('applied', 'replayed') THEN v_unc END;
  END;
  $fn$;

  EXECUTE format('ALTER FUNCTION public.rebook_round_selection_apply_as_actor(uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],bytea) OWNER TO %I', v_a);
  REVOKE ALL ON FUNCTION public.rebook_round_selection_apply_as_actor(uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],bytea)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.rebook_round_selection_apply_as_actor(uuid,uuid,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],bytea)
    TO authenticated;

  RAISE NOTICE 'D7: the terminal semantics closure is installed (digest, preview, apply)';
END $d7_semantics_closure$;
