-- D7 RUNTIME — THE SELECTION AUTHORITY: ONE CLUSTERER, TWO CANDIDATE MODES, ONE ACTOR SURFACE.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_COHORT_CUTOVER_FINAL_ARCHITECTURE_V1`). This replaces the
-- source-cycle-only derivation that briefly lived at `20261203170000` with ONE shared clusterer
-- both wizards reach. Two derivations of "which slots does this selection mean" would be two
-- selection authorities whatever their comments said, and the only genuine difference between the
-- wizards is which CANDIDATE slots they start from — so that is the only thing that differs here.
--
-- `20261203170000` IS REMOVED FROM THE LINEAGE RATHER THAN SUPERSEDED IN IT, and the distinction
-- matters. The supersede-never-amend rule exists so that a migration which may already have run
-- somewhere cannot change under a database that ran it. That file ran nowhere: it was never
-- committed, never pushed and never applied outside this worktree, and its entire effect would
-- have been undone by the very next file. A create-then-drop pair in the permanent lineage is
-- noise every future reader has to decode, so it is folded away here and its one durable finding —
-- the DST collision below — is carried forward in full.
--
-- ── THE CLUSTER IDENTITY IS ACADEMY-LOCAL, AND THAT IS AN OWNER DECISION ────────────────────
--
-- `DST_GROUPING=USE_ACADEMY_LOCAL_WEEKDAY_AND_LOCAL_TIME_AS_THE_CANONICAL_CLUSTER_IDENTITY_ACROSS
-- _DST`. The legacy Edge function clustered on UTC weekday + UTC HH:MM and said so in its own
-- comment: "a DST change mid-term could split a series; minor". It is not minor here, and the
-- reason is worth keeping because it is not obvious:
--
--   A Tuesday 19:00 class running September to December is 17:00Z before the October change and
--   18:00Z after it. Under UTC clustering that is TWO series. Both would be minted as separate
--   children — and ABC-27 derives each child's STORED series identity from its academy-LOCAL
--   weekday and time, so both children would carry the IDENTICAL `series_key` and the IDENTICAL
--   `target_name`. The typed core refuses that. One ordinary autumn cyclus would have made the
--   whole preview unusable, and nothing in the previous file's evidence could see it because every
--   fixture sat inside a single DST regime.
--
-- So the cluster identity is `location | trainer | academy-local weekday | academy-local time`,
-- which is the same four facts ABC-27 canonicalizes, and one local recurring series stays ONE
-- series across a DST boundary (`REFUSAL=DO_NOT_REFUSE_A_VALID_LOCAL_SERIES_SOLELY_BECAUSE_OF_A
-- _DST_BOUNDARY`). The rendered key here is NOT byte-equal to ABC-27's canonical `series_key` —
-- that one is built from the A-owned `rebook_round_canon_*` vocabulary, which Domain P holds no
-- EXECUTE on — but it is a function of the same four facts, so the two are in bijection. This one
-- is the SELECTION key the operator's exclusions are expressed in; ABC-27's is the STORED identity.
--
-- ── WHAT ELSE IS LEGACY, EXACTLY ────────────────────────────────────────────────────────────
--
-- Ported from `supabase/functions/bulk-rebook-cycle/index.ts`:
--
--   • SOURCE-CYCLE MODE: every slot whose `cyclus_id` is the source cycle. No term window and no
--     status filter — the whole cyclus is the candidate set, and every series qualifies.
--   • COHORT MODE: the academy's slots at the chosen locations whose `start_time` falls in
--     [termEnd - 200 days, termEnd], where termEnd is `<date>T23:59:59.999Z` — a UTC instant, as
--     the legacy function computes it. A series qualifies when its LAST session falls in the
--     term-end week, [termEndMs - 6 days, termEndMs].
--   • EXTEND suppression: drop a series whose template slot's `cyclus_id` is already named by a
--     NON-DRAFT cycle of the round. A series whose template carries NO cyclus id — a hand-added
--     slot, reachable only in cohort mode — falls back to the legacy NAME CHAIN: its tier-1 base
--     name matching a sent name exactly, or with a ` ·` or ` #` suffix.
--   • EXCLUSION: the operator removes whole series by key. `computeRebookExclusion`'s second
--     bucket is not ported — ABC-26 refuses every supplementary-priority submission, so the
--     included set is simply the complement of the excluded set.
--
-- ORDER IS MADE DETERMINISTIC, WHICH THE LEGACY ORDER WAS NOT: the Edge function flattened a
-- JavaScript `Map` whose insertion order followed an unordered PostgREST fetch. Ordering is an
-- input to the reviewed source-state digest, so it must be identical on every call. Series are
-- ordered by earliest session, then by key; slots within a series by start, then id.
--
-- ── THE CHILD IDENTITY IS DERIVED, NOT MINTED ───────────────────────────────────────────────
--
-- `CLIENT=NO_FINAL_SOURCE_SLOT_ARRAY` means the browser cannot mint a uuid per series either — it
-- does not know the series. ABC-27's `IDENTITY=CLIENT_MINTED_COMMAND_ROUND_CHILD_AND_PREVIEWED
-- _TARGET_SLOT_UUIDS_ONLY` is therefore departed from for the CHILD half only, deliberately and
-- narrowly: a child id is `md5(round_id || '|' || series_key)`. The round uuid is still client
-- minted, so children stay unique across rounds; the derivation is stable, so the same selection
-- previews and applies to the SAME identities and the reviewed fingerprint survives the round
-- trip. Nothing else about the identity contract moves: command, round and target slot uuids are
-- still the client's.
--
-- ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────────────────────
--
-- No new table, role, RLS policy or client privilege. The selection intent is an ARGUMENT, never
-- a row: the caller re-sends locations, term end and exclusion keys on every call, and the
-- `selection_digest` fences a stale one. Every `d7_p_*` routine below is Domain-P owned and
-- granted to the Domain-A owner alone, so there is no client-reachable derivation surface.

DO $d7_selection_authority$
DECLARE
  v_a  name;
  v_p  name;
  v_preview_sig CONSTANT text :=
    'public.rebook_round_preview_command_as_actor(uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])';
BEGIN
  -- THE SAME PREREQUISITE GUARD ITS SIBLINGS CARRY, in the same shape: `pg_catalog`, never the
  -- privilege-filtered `information_schema`.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure(v_preview_sig) IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27)';
    RETURN;
  END IF;

  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_preview_sig);
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  IF v_a IS NULL OR v_p IS NULL THEN
    RAISE EXCEPTION 'D7 selection authority: cannot resolve both domain owners (A=%, P=%)', v_a, v_p;
  END IF;
  IF v_a = v_p THEN
    RAISE EXCEPTION 'D7 selection authority: Domain A and Domain P resolved to the same role %, so the A/P bridge cannot be installed', v_a;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER')
     OR NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 selection authority: % is not a member of both domain owners', current_user;
  END IF;

  -- ── (1) THE TWO PURE RENDERERS ────────────────────────────────────────────────────────────

  -- "Wo 09:00" — the legacy `seriesLabel`, which formats with `Intl.DateTimeFormat("nl-NL",
  -- {weekday:"short"})`, capitalizes the first letter and strips a trailing period.
  --
  -- THE WEEKDAY IS A CASE, NOT A LOCALE LOOKUP, and that is deliberate. This cluster initializes
  -- with `LC_TIME=C`, so `to_char(…, 'TMDy')` renders ENGLISH abbreviations here and whatever the
  -- server's locale says elsewhere — a name that changes with a cluster setting is not a name the
  -- review can promise. The seven strings are the nl-NL abbreviations, written out.
  CREATE FUNCTION public.d7_series_label(p_weekday int, p_time time)
  RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public
  AS $lbl$
    SELECT CASE p_weekday
             WHEN 0 THEN 'Zo' WHEN 1 THEN 'Ma' WHEN 2 THEN 'Di' WHEN 3 THEN 'Wo'
             WHEN 4 THEN 'Do' WHEN 5 THEN 'Vr' WHEN 6 THEN 'Za'
           END || ' ' || to_char(p_time, 'HH24:MI')
  $lbl$;

  -- The legacy disambiguation chain, array in and array out, aligned with `p_keys`.
  --
  -- Tier 0: a single series with no taken names keeps the round name VERBATIM — byte-identical to
  --         the behaviour before per-series targets existed.
  -- Tier 1: `<label> — <Dag HH:mm>`.
  -- Tier 2: still colliding within this run, or with a name the round already holds → append the
  --         trainer's first name.
  -- Tier 3: still colliding → append the location name.
  -- Tier 4: still colliding → a numeric suffix, skipping suffixes the round already occupies.
  --
  -- "Colliding" means the same thing at every tier: this name appears more than once in the
  -- CURRENT tier, or it is already taken. That is why the counts are recomputed between tiers
  -- rather than taken once.
  CREATE FUNCTION public.d7_child_target_names(
    p_label     text,
    p_keys      text[],
    p_weekday   int[],
    p_time      time[],
    p_trainer   text[],
    p_location  text[],
    p_taken     text[]
  ) RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = public
  AS $nm$
  DECLARE
    v_n      int := coalesce(array_length(p_keys, 1), 0);
    v_names  text[] := ARRAY[]::text[];
    v_taken  text[] := coalesce(p_taken, ARRAY[]::text[]);
    v_dup    jsonb;
    v_i      int;
    v_base   text;
    v_cand   text;
    v_seen   jsonb := '{}'::jsonb;
    v_k      int;
  BEGIN
    IF v_n = 0 THEN RETURN ARRAY[]::text[]; END IF;
    IF v_n = 1 AND coalesce(array_length(v_taken, 1), 0) = 0 THEN
      RETURN ARRAY[p_label];
    END IF;

    -- Tier 1.
    FOR v_i IN 1 .. v_n LOOP
      v_names := v_names || (p_label || ' — ' || public.d7_series_label(p_weekday[v_i], p_time[v_i]));
    END LOOP;

    -- Tier 2 — trainer.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) AND p_trainer[v_i] IS NOT NULL THEN
        v_names[v_i] := v_names[v_i] || ' · ' || p_trainer[v_i];
      END IF;
    END LOOP;

    -- Tier 3 — location.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) AND p_location[v_i] IS NOT NULL THEN
        v_names[v_i] := v_names[v_i] || ' · ' || p_location[v_i];
      END IF;
    END LOOP;

    -- Tier 4 — numeric, skipping what the round already holds. The FIRST colliding instance of a
    -- base keeps the base itself (n = 1 renders no suffix), which is the legacy behaviour and the
    -- reason `v_seen` counts per BASE rather than per row.
    v_dup := public.d7_name_counts(v_names);
    FOR v_i IN 1 .. v_n LOOP
      IF public.d7_name_colliding(v_dup, v_names[v_i], v_taken) THEN
        v_base := v_names[v_i];
        v_k := coalesce((v_seen ->> v_base)::int, 0) + 1;
        v_cand := CASE WHEN v_k = 1 THEN v_base ELSE v_base || ' #' || v_k::text END;
        WHILE v_cand = ANY (v_taken) LOOP
          v_k := v_k + 1;
          v_cand := v_base || ' #' || v_k::text;
        END LOOP;
        v_seen := jsonb_set(v_seen, ARRAY[v_base], to_jsonb(v_k));
        v_names[v_i] := v_cand;
      END IF;
    END LOOP;

    RETURN v_names;
  END;
  $nm$;

  -- The two helpers the chain leans on, kept separate so each tier reads like the code it was
  -- ported from rather than like an inlined counting expression repeated four times.
  CREATE FUNCTION public.d7_name_counts(p_names text[])
  RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public
  AS $ct$
    SELECT coalesce(jsonb_object_agg(n, c), '{}'::jsonb)
      FROM (SELECT x AS n, count(*)::int AS c FROM unnest(p_names) x GROUP BY x) s
  $ct$;

  CREATE FUNCTION public.d7_name_colliding(p_counts jsonb, p_name text, p_taken text[])
  RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public
  AS $cl$
    SELECT coalesce((p_counts ->> p_name)::int, 0) > 1 OR p_name = ANY (coalesce(p_taken, ARRAY[]::text[]))
  $cl$;

  -- ── (2) THE DOMAIN-P BRIDGES ──────────────────────────────────────────────────────────────
  --
  -- Everything that reads a product relation lives here, for the reason `20261203170000` measured
  -- the hard way: an A-owned body reading `public.cycles` dies on that table's own RLS policy,
  -- which resolves `trainer_profiles` — a policy expression runs as the querying role, and Domain A
  -- owns neither table. ABC-27 records the same failure for the retired
  -- `rebook_sibling_has_free_seat`.

  -- The academy's display timezone, with the SAME fallback every other surface uses.
  CREATE FUNCTION public.d7_p_academy_timezone(p_academy uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $tz$
    SELECT coalesce(nullif(btrim(ap.timezone), ''), 'Europe/Amsterdam')
      FROM public.academy_profiles ap WHERE ap.id = p_academy
  $tz$;

  -- Source-cycle mode's candidate set: the whole cyclus, re-anchored to the academy.
  CREATE FUNCTION public.d7_p_cyclus_candidates(p_academy uuid, p_source_cycle uuid)
  RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $cc$
    SELECT coalesce(array_agg(s.id ORDER BY s.id), ARRAY[]::uuid[])
      FROM public.availability_slots s
     WHERE p_source_cycle IS NOT NULL
       AND s.cyclus_id = p_source_cycle
       AND s.academy_profile_id = p_academy
       -- REVIEW ROUND 1 (P2): THE SOURCE MUST BE A CYCLUS OF THIS ACADEMY. The retired producer
       -- resolved the source through `cycles` with `type = 'cyclus'` and the academy owner before
       -- it fetched a slot; matching `cyclus_id` alone let an authenticated manager name an event
       -- or registration cycle that happens to carry slots and rebook it as a weekly course.
       AND EXISTS (SELECT 1 FROM public.cycles c
                    WHERE c.id = p_source_cycle
                      AND c.owner_type = 'academy' AND c.owner_id = p_academy
                      AND c.type = 'cyclus')
  $cc$;

  -- Cohort mode's candidate set: the academy's slots at the chosen locations inside the legacy
  -- lookback. The window is computed on the UTC instant the legacy function computes — the term
  -- end is `<date>T23:59:59.999Z` and the lookback is 200 days — because this is the SAME
  -- selection, not a better one.
  CREATE FUNCTION public.d7_p_cohort_candidates(p_academy uuid, p_location_ids uuid[], p_term_end date)
  RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $oc$
    SELECT coalesce(array_agg(s.id ORDER BY s.id), ARRAY[]::uuid[])
      FROM public.availability_slots s
     WHERE p_term_end IS NOT NULL
       AND coalesce(array_length(p_location_ids, 1), 0) > 0
       AND s.academy_profile_id = p_academy
       AND s.location_id = ANY (p_location_ids)
       AND s.start_time <= (p_term_end + time '23:59:59.999') AT TIME ZONE 'UTC'
       AND s.start_time >= ((p_term_end + time '23:59:59.999') AT TIME ZONE 'UTC') - interval '200 days'
  $oc$;

  -- Trainer and location DISPLAY names, for the naming chain and the review projection.
  -- A trainer's display name lives on their PROFILE, never on `trainer_profiles` — the legacy
  -- function learned that from a 42703 that silently emptied the map and dropped every trainer
  -- prefix from every disambiguated name.
  CREATE FUNCTION public.d7_p_display_names(p_trainer_ids uuid[], p_location_ids uuid[])
  RETURNS TABLE (kind text, subject_id uuid, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $dn$
    SELECT 'trainer'::text, tp.id, nullif(btrim(pr.full_name), '')
      FROM public.trainer_profiles tp
      JOIN public.profiles pr ON pr.user_id = tp.user_id
     WHERE tp.id = ANY (coalesce(p_trainer_ids, ARRAY[]::uuid[]))
    UNION ALL
    SELECT 'location'::text, l.id, nullif(btrim(l.name), '')
      FROM public.locations l
     WHERE l.id = ANY (coalesce(p_location_ids, ARRAY[]::uuid[]))
  $dn$;

  -- The cohort's display names and email PRESENCE — never an address.
  --
  -- IT TAKES SLOTS, NOT SUBJECT IDS, AND THAT IS THE TENANT BOUNDARY. `guest_players` carries no
  -- academy column — a guest belongs to a TRAINER — so a bridge that accepted a guest id list
  -- would have no relational way to prove those guests were this academy's, and would be trusting
  -- its caller for containment. Deriving the subjects here from bookings on slots re-anchored to
  -- the academy makes the boundary a join: there is no argument that names a person, so there is
  -- no way to ask this function about somebody else's player.
  --
  -- Guest-first keying is `cohortPersonKey`'s: a dual-keyed booking is the GUEST person, so the
  -- review shows the guest's own name and email presence, not the linked profile's. Email presence
  -- mirrors the invite sender's `effectiveGuestEmail` — the guest's own address and nothing else,
  -- so the no-email count is who would actually be skipped at send time.
  CREATE FUNCTION public.d7_p_subject_display(p_academy uuid, p_slot_ids uuid[])
  RETURNS TABLE (slot_id uuid, recipient_key text, display_name text, has_email boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $sd$
    WITH anchored AS (
      SELECT s.id FROM public.availability_slots s
       WHERE s.id = ANY (coalesce(p_slot_ids, ARRAY[]::uuid[]))
         AND s.academy_profile_id = p_academy
    ),
    subject AS (
      SELECT DISTINCT b.slot_id, b.guest_player_id, b.player_id
        FROM public.bookings b JOIN anchored a ON a.id = b.slot_id
       WHERE coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
         AND (b.guest_player_id IS NOT NULL OR b.player_id IS NOT NULL)
    )
    SELECT su.slot_id, 'g:' || g.id::text,
           coalesce(nullif(btrim(g.full_name), ''), '—'),
           (g.email IS NOT NULL AND btrim(g.email) <> '')
      FROM subject su JOIN public.guest_players g ON g.id = su.guest_player_id
    UNION ALL
    SELECT su.slot_id, pr.id::text,
           coalesce(nullif(btrim(pr.full_name), ''), '—'),
           (pr.email IS NOT NULL AND btrim(pr.email) <> '')
      FROM subject su JOIN public.profiles pr ON pr.id = su.player_id
     WHERE su.guest_player_id IS NULL
  $sd$;

  -- The round's already-taken cycle names, for the extend name chain and tier 4.
  CREATE FUNCTION public.d7_p_round_taken_names(p_academy uuid, p_round uuid, p_start date)
  RETURNS TABLE (name text, is_sent boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $tn$
    -- The round's own non-draft cycles: both TAKEN (a name may not be reused) and SENT (the
    -- legacy name-chain fallback matches against exactly these).
    SELECT c.name, true
      FROM public.cycles c
     WHERE p_round IS NOT NULL
       AND c.owner_type = 'academy' AND c.owner_id = p_academy
       AND c.settings->>'rebook_round_id' = p_round::text
       AND c.settings->>'rebook_payment_mode' IS NOT NULL
       AND c.status <> 'draft'
    UNION ALL
    -- Same-start-date rebook cycles are TAKEN but not sent: `uniq_rebook_cycle_key` is keyed on
    -- (owner_type, owner_id, name, start_date), so a same-date name collides whoever owns it.
    -- REVIEW ROUND 3 (P2): DRAFTS COUNT HERE. `uniq_rebook_cycle_key` is unique over
    -- `status IN ('draft','open')`, so a leftover draft with this academy, name and start date
    -- collides at INSERT while being invisible to every review — the operator saw a clean name,
    -- every apply chose it, and every apply failed at the index. The SENT arm above still excludes
    -- drafts, because "already invited" is a different question from "this name is taken".
    SELECT c.name, false
      FROM public.cycles c
     WHERE p_start IS NOT NULL
       AND c.owner_type = 'academy' AND c.owner_id = p_academy
       AND c.start_date = p_start
       AND c.settings->>'rebook_payment_mode' IS NOT NULL
       AND c.status IN ('draft', 'open')
  $tn$;

  -- The round's own label, as the legacy extend path reads it: the first non-blank
  -- `settings->>rebook_round_label` among the round's cycles.
  CREATE FUNCTION public.d7_p_round_label(p_academy uuid, p_round uuid)
  RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $rl$
    SELECT nullif(btrim(c.settings->>'rebook_round_label'), '')
      FROM public.cycles c
     WHERE p_round IS NOT NULL
       AND c.owner_type = 'academy' AND c.owner_id = p_academy
       AND c.settings->>'rebook_round_id' = p_round::text
       AND c.settings->>'rebook_payment_mode' IS NOT NULL
       AND nullif(btrim(c.settings->>'rebook_round_label'), '') IS NOT NULL
     ORDER BY c.created_at, c.id
     LIMIT 1
  $rl$;

  -- ── (3) THE ONE CLUSTERER ─────────────────────────────────────────────────────────────────
  --
  -- One row per candidate slot, carrying its series, that series' flags and the deterministic
  -- ordering. Both modes hand it a candidate array and it does everything else, so there is
  -- exactly one place where "which slots form a group" is decided.
  CREATE FUNCTION public.d7_p_series_cluster(
    p_academy        uuid,
    p_candidates     uuid[],
    p_mode           text,      -- 'source_cycle' | 'cohort'
    p_term_end       date,      -- cohort mode only: the term-end week test
    p_round          uuid,      -- extend suppression; NULL on a create
    p_round_label    text,      -- extend name-chain fallback
    p_excluded_keys  text[]
  ) RETURNS TABLE (
    series_key    text,
    series_first  timestamptz,
    series_last   timestamptz,
    local_weekday int,
    local_time    time,
    trainer_id    uuid,
    location_id   uuid,
    -- THE TEMPLATE SLOT'S OWN FACTS, which the review projection renders and the occurrence
    -- generator needs. They come from the SAME template row the legacy `series[0]` read, so a
    -- heterogeneous series shows the same price and flags the legacy review showed. The typed
    -- core independently REFUSES a series whose members disagree on any of them, so this is a
    -- rendering, never the authority.
    tmpl_price    numeric,
    tmpl_split    boolean,
    tmpl_vat      boolean,
    tmpl_max      int,
    tmpl_minutes  int,
    qualifies     boolean,   -- cohort mode's term-end-week test
    suppressed    boolean,   -- extend: this series is already in the round
    excluded      boolean,   -- the operator removed it
    slot_id       uuid,
    slot_start    timestamptz,
    slot_cyclus   uuid
  ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $cl$
    WITH tz AS (SELECT public.d7_p_academy_timezone(p_academy) AS zone),
    candidate AS (
      SELECT s.id, s.start_time, s.trainer_id, s.location_id, s.cyclus_id,
             s.price_per_session AS price, s.split_payment AS split,
             s.prices_include_vat AS vat, s.max_participants AS maxp,
             -- REVIEW ROUND 3 (P2): EPOCH DIFFERENCE, NOT INTERVAL SUBTRACTION, AND NO ROUNDING
             -- INTO PLAUSIBILITY. `end - start` on two extreme legal timestamptz values can raise
             -- `interval out of range` inside the COUNTING projection — before the typed core can
             -- answer in its own vocabulary — and `(…)::int` silently rounded a 90.5-minute slot to
             -- 91, so the projection showed a duration the core then refused as unrepresentable.
             -- Subtracting epochs cannot overflow, and a duration that is not a whole number of
             -- minutes is NULL here: the core refuses it, which is the honest answer, rather than
             -- this file inventing a nearby one.
             -- REVIEW ROUND 4 (P2): THE CORE'S BOUNDS, NOT JUST WHOLE MINUTES. The core derives
             -- NULL for a duration that is not strictly between 0 and 1,440 minutes, so a two-day
             -- slot projected 2,880 while the core refused it — and an exact-minute span beyond
             -- `int` raised here instead of reaching a typed refusal. Every one of those is NULL
             -- now, which is what the core will say.
             CASE WHEN (extract(epoch FROM s.end_time) - extract(epoch FROM s.start_time)) % 60 = 0
                   AND (extract(epoch FROM s.end_time) - extract(epoch FROM s.start_time)) > 0
                   AND (extract(epoch FROM s.end_time) - extract(epoch FROM s.start_time)) <= 1440 * 60
                  THEN ((extract(epoch FROM s.end_time) - extract(epoch FROM s.start_time)) / 60)::int
             END AS minutes,
             extract(dow FROM (s.start_time AT TIME ZONE t.zone))::int AS lw,
             (s.start_time AT TIME ZONE t.zone)::time                  AS lt
        FROM public.availability_slots s CROSS JOIN tz t
       WHERE s.id = ANY (coalesce(p_candidates, ARRAY[]::uuid[]))
         AND s.academy_profile_id = p_academy
    ),
    keyed AS (
      SELECT c.*,
             coalesce(c.location_id::text, '_') || '|' ||
             coalesce(c.trainer_id::text, '_')  || '|' ||
             c.lw::text || '|' || to_char(c.lt, 'HH24:MI:SS.US') AS skey
        FROM candidate c
    ),
    series AS (
      SELECT k.skey,
             min(k.start_time) AS first_start,
             max(k.start_time) AS last_start,
             min(k.lw)         AS lw,
             min(k.lt)         AS lt,
             -- The TEMPLATE is the earliest slot, exactly as the legacy `series[0]` is: the array
             -- was sorted by start before anything read `tmpl`.
             (array_agg(k.trainer_id  ORDER BY k.start_time, k.id))[1] AS trainer_id,
             (array_agg(k.location_id ORDER BY k.start_time, k.id))[1] AS location_id,
             (array_agg(k.cyclus_id   ORDER BY k.start_time, k.id))[1] AS tmpl_cyclus,
             (array_agg(k.price       ORDER BY k.start_time, k.id))[1] AS tmpl_price,
             (array_agg(k.split       ORDER BY k.start_time, k.id))[1] AS tmpl_split,
             (array_agg(k.vat         ORDER BY k.start_time, k.id))[1] AS tmpl_vat,
             (array_agg(k.maxp        ORDER BY k.start_time, k.id))[1] AS tmpl_max,
             (array_agg(k.minutes     ORDER BY k.start_time, k.id))[1] AS tmpl_minutes
        FROM keyed k GROUP BY k.skey
    ),
    sent AS (
      SELECT n.name FROM public.d7_p_round_taken_names(p_academy, p_round, NULL) n WHERE n.is_sent
    ),
    flagged AS (
      SELECT se.*,
             -- Cohort mode keeps only series whose LAST session lands in the term-end week;
             -- source-cycle mode qualifies every series.
             CASE WHEN p_mode = 'cohort'
                  THEN se.last_start >= ((p_term_end + time '23:59:59.999') AT TIME ZONE 'UTC') - interval '6 days'
                   AND se.last_start <=  ((p_term_end + time '23:59:59.999') AT TIME ZONE 'UTC')
                  ELSE true END AS qualifies,
             CASE
               WHEN p_round IS NULL THEN false
               -- Matched by SOURCE cycle id when the template has one — naming-proof.
               WHEN se.tmpl_cyclus IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM public.cycles rc
                  WHERE rc.owner_type = 'academy' AND rc.owner_id = p_academy
                    AND rc.settings->>'rebook_round_id' = p_round::text
                    AND rc.settings->>'rebook_payment_mode' IS NOT NULL
                    AND rc.status <> 'draft'
                    AND rc.settings->>'rebook_source_cyclus_id' = se.tmpl_cyclus::text)
               -- A hand-added series carries no cyclus, so the legacy fallback matches its tier-1
               -- base name against the round's sent names, bare or suffixed.
               -- `left(...) = prefix`, NOT `LIKE prefix || '%'`. The legacy test is JavaScript's
               -- `startsWith`, and a round label containing `_` or `%` would make LIKE match names
               -- the legacy chain never matched — a suppression that silently drops a group.
               ELSE EXISTS (
                 SELECT 1 FROM sent s
                  CROSS JOIN LATERAL (SELECT coalesce(p_round_label, '') || ' — '
                                             || public.d7_series_label(se.lw, se.lt) AS base) b
                  WHERE s.name = b.base
                     OR left(s.name, length(b.base) + 2) = b.base || ' ·'
                     OR left(s.name, length(b.base) + 2) = b.base || ' #')
             END AS suppressed
        FROM series se
    )
    SELECT f.skey, f.first_start, f.last_start, f.lw, f.lt, f.trainer_id, f.location_id,
           f.tmpl_price, f.tmpl_split, f.tmpl_vat, f.tmpl_max, f.tmpl_minutes,
           f.qualifies, f.suppressed,
           -- REVIEW ROUND 1 (P2): `x = ANY(array containing NULL)` is NULL for a non-match, not
           -- false. `NOT c.excluded` then dropped those series from the FINAL arrays while the
           -- checklist coalesced the same NULL to `false` — so `ARRAY[NULL]::text[]` displayed
           -- every series as included and submitted an empty source set. The NULLs are stripped
           -- here, where the comparison is, rather than coalesced at each of the four use sites.
           f.skey = ANY (ARRAY(SELECT x FROM unnest(coalesce(p_excluded_keys, ARRAY[]::text[])) x
                                WHERE x IS NOT NULL)),
           k.id, k.start_time, k.cyclus_id
      FROM flagged f JOIN keyed k ON k.skey = f.skey
     ORDER BY f.first_start, f.skey, k.start_time, k.id
  $cl$;

  -- ── (3a) THE CHILD IDENTITY — ONE DERIVATION, AND A WELL-FORMED UUID ──────────────────────
  --
  -- REVIEW ROUND 2 (P1). `md5(round || '|' || key)::uuid` is a legal `uuid` VALUE, and it is not a
  -- legal RFC 4122 v4: its version and variant nibbles are whatever the digest produced. Measured
  -- over 200 keys, 186 of them fail the browser's own uuid predicate — which validates version and
  -- variant, as a strict client decoder should. The effect was that a SUCCESSFUL apply decoded as
  -- `unknown`, so the round existed and its invitations were never drained.
  --
  -- The fix belongs here rather than in a looser client regex: a client that stopped checking the
  -- version and variant would also stop rejecting the malformed ids it is there to catch. The
  -- version nibble is forced to 4 and the variant to one of 8/9/a/b, keeping the derived id
  -- deterministic, stable across preview and apply, unique per (round, series), and — crucially —
  -- indistinguishable in shape from the identities the client mints itself.
  --
  -- ONE FUNCTION, for the reason the digest is one function: both surfaces derive this, and two
  -- copies of an identity formula is one edit away from a round whose preview and apply disagree
  -- about which children they are talking about.
  CREATE FUNCTION public.d7_child_cycle_id(p_round uuid, p_series_key text)
  RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = public
  AS $ci$
    SELECT (substr(h.d, 1, 12) || '4' || substr(h.d, 14, 3)
            || substr('89ab', 1 + (('x' || substr(h.d, 17, 1))::bit(4)::int % 4), 1)
            || substr(h.d, 18, 15))::uuid
      FROM (SELECT md5(coalesce(p_round::text, '') || '|' || coalesce(p_series_key, '')) AS d) h
  $ci$;

  -- ── (3b) THE SELECTION DIGEST — ONE FORMULA, NOT TWO ──────────────────────────────────────
  --
  -- REVIEW ROUND 1 (P1). The preview surface and the apply surface each computed this inline, and
  -- the moment the preview's version was widened the two disagreed — every apply answered
  -- `selection_moved` against a digest the preview had just issued. A fence whose two ends compute
  -- it separately is a fence that only works while nobody edits it.
  --
  -- WHAT IT COVERS, AND WHY EACH PART. The (series, slot) pairs are the selection itself. The
  -- template facts are what the review PROJECTS — price, split, VAT, capacity, duration — so a
  -- court repriced between the projection read and the core's derivation moves the digest instead
  -- of quietly changing the round. The label and the round's taken names are what the naming chain
  -- is a function of, so a same-date cycle committing between this wrapper's read and the core's
  -- moves it too. This does not make a READ COMMITTED sequence atomic; it makes it FAIL CLOSED.
  --
  -- Taken BEFORE exclusion: the keys the caller echoes were issued from the unreduced set.
  CREATE FUNCTION public.d7_p_selection_digest(
    p_academy       uuid,
    p_candidates    uuid[],
    p_mode          text,
    p_term_end      date,
    p_round         uuid,
    p_round_label   text,
    p_excluded_keys text[],
    p_target_start  date
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
                                                     AND c.location_id IS NOT NULL)) d), ''),
             'UTF8'))
  $dg$;

  -- ── (4) OWNERSHIP AND PRIVILEGE ───────────────────────────────────────────────────────────
  --
  -- OWNERSHIP FIRST, PRIVILEGES SECOND: `ALTER FUNCTION … OWNER TO` REWRITES the ACL's owner
  -- entries, so a REVOKE/GRANT issued before the transfer is partly undone by it.
  EXECUTE format('ALTER FUNCTION public.d7_series_label(int,time) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_name_counts(text[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_name_colliding(jsonb,text,text[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_academy_timezone(uuid) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_cyclus_candidates(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_cohort_candidates(uuid,uuid[],date) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_display_names(uuid[],uuid[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_subject_display(uuid,uuid[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_round_taken_names(uuid,uuid,date) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_round_label(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_child_cycle_id(uuid,text) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_series_cluster(uuid,uuid[],text,date,uuid,text,text[]) OWNER TO %I', v_p);

  -- THE SAME NEGATIVE SPACE EVERY `bridge_p` ROW CARRIES: revoked from PUBLIC and all three
  -- runtime roles, then granted to the Domain-A owner and to nothing else. No client role can
  -- reach any of them, so this file adds no derivation API.
  REVOKE ALL ON FUNCTION public.d7_series_label(int,time) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_name_counts(text[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_name_colliding(jsonb,text,text[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_academy_timezone(uuid) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_cyclus_candidates(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_cohort_candidates(uuid,uuid[],date) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_display_names(uuid[],uuid[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_subject_display(uuid,uuid[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_round_taken_names(uuid,uuid,date) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_round_label(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_child_cycle_id(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_series_cluster(uuid,uuid[],text,date,uuid,text,text[]) FROM PUBLIC, anon, authenticated, service_role;

  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_series_label(int,time) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_name_counts(text[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_name_colliding(jsonb,text,text[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_academy_timezone(uuid) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_cyclus_candidates(uuid,uuid) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_cohort_candidates(uuid,uuid[],date) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_display_names(uuid[],uuid[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_subject_display(uuid,uuid[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_round_taken_names(uuid,uuid,date) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_round_label(uuid,uuid) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_child_cycle_id(uuid,text) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_selection_digest(uuid,uuid[],text,date,uuid,text,text[],date) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_series_cluster(uuid,uuid[],text,date,uuid,text,text[]) TO %I', v_a);

  RAISE NOTICE 'D7: the selection authority is installed — % owns the bridges, % may call them', v_p, v_a;
END $d7_selection_authority$;
