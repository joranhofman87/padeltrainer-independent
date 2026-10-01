-- D7 RUNTIME — THE ONE ACTOR-AUTHORIZED SELECTION SURFACE.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_COHORT_CUTOVER_FINAL_ARCHITECTURE_V1`):
-- `SURFACE=ONE_ACTOR_AUTHORIZED_rebook_round_selection_preview_as_actor_WRAPPER_WITH_CLOSED
-- _selection_mode_AND_p_projection_VOCABULARIES`.
--
-- One wrapper, two closed vocabularies, and nothing generic. `p_selection_mode` says where the
-- candidate slots come from — a source cycle, or locations plus a term-end week — and `p_projection`
-- says how much of the answer the caller is asking for. Both are two-value vocabularies validated
-- against a literal list, so this is a purpose-bound surface with two purposes rather than a
-- parameterized derivation API.
--
-- ── WHAT `counts` AND `review` MEAN, AND WHY THEY ARE DIFFERENT ─────────────────────────────
--
-- `PROJECTION=counts_IS_ADVISORY_AND_CANNOT_ARM_A_SEND_review_IS_RECEIPT_BOUND_TO_THE_SAME_TYPED
-- _PREVIEW_OBSERVATION`. This is not a convenience split — the two answer different questions and
-- one of them CANNOT be answered by the typed core at all:
--
--   • `counts` serves the cohort wizard's auto-count, which fires on locations and dates ALONE:
--     no label, no length, no price. The typed preview core refuses exactly that shape — a NULL
--     round id in §(1), a NULL label in §(1), and `num_nonnulls(end, weeks) <> 1` in §(3) — so a
--     design that answered the auto-count from the core would return `invalid_request` forever.
--     `counts` therefore does NOT call the core, returns NO fingerprint, and says `counted`.
--     A caller cannot mistake it for an approval because there is nothing to approve WITH.
--   • `review` calls the core in the same transaction as the derivation and returns its verdict,
--     its `review_fingerprint` and the projection together. That co-derivation IS the binding: the
--     roster, the totals and the fingerprint describe ONE observation of one source state, so an
--     operator cannot approve numbers that came from a different read than the one they will
--     apply.
--
-- ── THE SELECTION DIGEST ────────────────────────────────────────────────────────────────────
--
-- The exclusion intent is a set of SERVER-ISSUED series keys. A key the caller received from an
-- earlier call could name a different series after the source moved, so every answer carries a
-- `selection_digest` over the ordered (series_key, slot_id) set BEFORE exclusion, and a caller
-- that echoes a stale one gets `selection_moved` instead of a quietly different round. This is
-- what makes the intent safe to keep as an ARGUMENT rather than a row: there is no new table, and
-- there is no window in which the server believes a selection the operator did not see.
--
-- ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────
--
-- `PRIVACY=RETAIN_MANAGER_ACADEMY_SCOPE_AND_RETURN_ONLY_DISPLAY_NAME_AND_EMAIL_PRESENCE_NOT_EMAIL
-- _ADDRESSES`. The roster arm returns a display name and a BOOLEAN, and it is reachable only
-- through the manager gate for the manager's own academy — which is exactly what the legacy dry
-- run already returned to the same actor, so this is parity and not a widening. `d7_p_subject_
-- display` takes SLOTS rather than person ids, so the tenant boundary is a join rather than a
-- promise, and no argument to this surface names a person.

DO $d7_selection_surface$
DECLARE
  v_a  name;
  v_p  name;
  v_preview_sig CONSTANT text :=
    'public.rebook_round_preview_command_as_actor(uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure(v_preview_sig) IS NULL
     OR to_regprocedure('public.d7_p_series_cluster(uuid,uuid[],text,date,uuid,text,text[])') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the selection authority)';
    RETURN;
  END IF;

  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_preview_sig);
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  IF v_a IS NULL OR v_p IS NULL OR v_a = v_p THEN
    RAISE EXCEPTION 'D7 selection surface: the two domain owners did not resolve distinctly (A=%, P=%)', v_a, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 selection surface: % is not a member of the Domain-A owner %', current_user, v_a;
  END IF;

  -- ── THE ONE OCCURRENCE COUNTER ────────────────────────────────────────────────────────────
  --
  -- The review's per-series session count is the SAME generation the typed core previews with:
  -- `rebook_round_generate_occurrences` over the merged holiday exclusion, not an arithmetic
  -- estimate. Two different session counts — one on the review screen, one in the round — is the
  -- exact divergence a projection exists to prevent, so the projection calls the generator rather
  -- than reproducing it.
  --
  -- Domain-A owned, because the generator and the exclusion merger are A vocabulary and Domain P
  -- holds no EXECUTE on either.
  CREATE FUNCTION public.d7_series_session_count(
    p_zone text, p_start date, p_weekday int, p_time time, p_minutes int,
    p_weeks int, p_end date, p_holiday_from date[], p_holiday_to date[]
  ) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $sc$
    SELECT count(*)::int
      FROM public.rebook_round_generate_occurrences(
             p_zone, p_start, p_weekday, p_time, p_minutes, p_weeks, p_end,
             (SELECT coalesce(array_agg(m.from_date ORDER BY m.range_ordinal), ARRAY[]::date[])
                FROM public.rebook_round_merge_exclusions(p_holiday_from, p_holiday_to) m),
             (SELECT coalesce(array_agg(m.to_date ORDER BY m.range_ordinal), ARRAY[]::date[])
                FROM public.rebook_round_merge_exclusions(p_holiday_from, p_holiday_to) m))
     WHERE p_start IS NOT NULL AND p_weekday IS NOT NULL AND p_time IS NOT NULL
       AND p_minutes IS NOT NULL AND num_nonnulls(p_end, p_weeks) = 1
  $sc$;

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
    has_email                 boolean
  )
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $fn$
  DECLARE
    -- NOT INITIALIZED IN `DECLARE`: `auth.uid()` casts the JWT subject and RAISES on a malformed
    -- one, and a raise during DECLARE escapes before any gate has run — which would distinguish
    -- "malformed token" from "not authorized" and make this surface the oracle it must not be.
    v_actor    uuid;
    v_refuse   text;
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
      v_label := coalesce(public.d7_p_round_label(p_academy_profile_id,
                            CASE WHEN p_command_kind = 'extend' THEN p_round_id END), p_label);
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
        v_label, p_excluded_series_keys, p_target_start);

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
        NULL::text, NULL::boolean;
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
           NULL::text, NULL::boolean;

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
           NULL::text, NULL::boolean
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
             r.display_name, r.has_email
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

  EXECUTE format('ALTER FUNCTION public.d7_series_session_count(text,date,int,time,int,int,date,date[],date[]) OWNER TO %I', v_a);
  REVOKE ALL ON FUNCTION public.d7_series_session_count(text,date,int,time,int,int,date,date[],date[])
    FROM PUBLIC, anon, authenticated, service_role;

  EXECUTE format('ALTER FUNCTION public.rebook_round_selection_preview_as_actor('
    || 'uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,'
    || 'text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,'
    || 'date[],date[],text[],uuid[]) OWNER TO %I', v_a);

  REVOKE ALL ON FUNCTION public.rebook_round_selection_preview_as_actor(
    uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,
    text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,
    date[],date[],text[],uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.rebook_round_selection_preview_as_actor(
    uuid,text,text,text,text,uuid,uuid[],date,text[],bytea,uuid,int,text,date,date,int,int,int,
    text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,
    date[],date[],text[],uuid[])
    TO authenticated;

  RAISE NOTICE 'D7: the selection preview surface is installed, granted to authenticated only';
END $d7_selection_surface$;
