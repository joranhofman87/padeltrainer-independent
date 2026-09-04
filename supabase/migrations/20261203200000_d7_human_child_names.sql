-- D7 RUNTIME — THE CHILD CYCLE'S NAME BECOMES HUMAN AGAIN.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_COHORT_CUTOVER_FINAL_ARCHITECTURE_V1`):
-- `CYCLE_NAMES=SERVER_DERIVE_HUMAN_READABLE_LEGACY_COMPATIBLE_DISAMBIGUATED_CHILD_NAMES`,
-- `CLIENT_NAMES=NO_BROWSER_SUPPLIED_OR_UUID_VISIBLE_CHILD_CYCLE_NAMES`,
-- `CONCURRENCY=NAME_DISAMBIGUATION_MUST_REMAIN_DETERMINISTIC_AND_SAFE_AT_APPLY_TIME`.
--
-- ── WHAT IT IS TODAY, AND WHY THAT IS A PRODUCT PROBLEM ─────────────────────────────────────
--
-- ABC-27 renders a child's `target_name` as
--
--     <label> · HH24:MI:SS.US · <weekday> · <location uuid> · <trainer uuid>
--
-- and that string reaches `public.cycles.name` through the apply bridge's `p_child_names[i]`. It
-- is unique by construction, which is what it was for; it is also what an operator and every
-- player of that group would read on the cycle. The legacy producer named the same cycle
-- `Volgende ronde 2026` — or `… — Wo 09:00`, escalating through the trainer's first name, the
-- location, then a number — and that is the name this release restores.
--
-- ── WHERE THE CHANGE IS MADE, AND WHY THERE ─────────────────────────────────────────────────
--
-- In BOTH normalized cores, and in nothing else. The name is canonicalized into the reviewed
-- pre-image (section 3 of the intent), so ABC-27's own rule applies — "leaving them out of the
-- pre-image would let an apply write names the review never saw". Changing it in the apply bridge
-- alone would have written a name the fingerprint never covered; changing it in one core alone
-- would have made every apply drift. Both cores carry the BYTE-IDENTICAL rendering, so both get
-- the byte-identical replacement and preview and apply still agree by construction.
--
-- CONCURRENCY IS FAIL-CLOSED, NOT BEST-EFFORT. The chain reads the names the round and the target
-- start date already hold. If another round takes one of those names between the review and the
-- apply, the apply re-derives a different name, the fingerprint differs, and the operator gets the
-- typed `source_drift` refusal with nothing written — which is the same answer they already get
-- when a source slot moves. `uniq_rebook_cycle_key` remains the backstop underneath.
--
-- ── HOW THE REPLACEMENT IS MADE, AND WHY NOT BY COPYING ─────────────────────────────────────
--
-- The two cores are roughly 840 and 1,400 lines. Transcribing them into this file to change one
-- expression would put every other line at the mercy of a copy, and a silent transcription error
-- inside an apply writer is exactly the class of defect nobody finds by reading. So the bodies are
-- taken from the catalog with `pg_get_functiondef`, transformed by two EXACT string substitutions
-- each, and re-issued. Everything not substituted is byte-identical BY CONSTRUCTION rather than by
-- inspection.
--
-- IT IS FAIL-CLOSED IN BOTH DIRECTIONS. Each substitution asserts its anchor occurs EXACTLY once
-- before it runs and that the result changed by exactly the expected shape; a core that does not
-- carry the reviewed rendering aborts this migration instead of being patched approximately.
-- `src/test/d7ForwardChain.realpg.test.ts` then diffs the installed bodies against ABC-27's and
-- asserts that NOTHING was deleted outside the replaced region.

DO $d7_human_names$
DECLARE
  v_a         name;
  v_p         name;
  v_core      text;
  v_src       text;
  v_new       text;
  v_before    text;
  v_after     text;
  v_ident     text;
  -- The EXACT rendering ABC-27 installs, in both cores. If this is not present, this migration is
  -- looking at something it has not reviewed.
  v_old_expr  CONSTANT text :=
    '           public.rebook_round_sanitize_copy(' || E'\n' ||
    '             v_eff_label || '' · '' || to_char(ch.local_time, ''HH24:MI:SS.US'')' || E'\n' ||
    '             || '' · '' || ch.local_weekday::text' || E'\n' ||
    '             || '' · '' || coalesce(ch.location_id::text, ''noloc'')' || E'\n' ||
    '             || '' · '' || coalesce(ch.trainer_id::text, ''notrn''), 300) AS target_name';
  v_new_expr  CONSTANT text :=
    '           -- D7 (20261203200000): the legacy human-readable name, disambiguated by the same' || E'\n' ||
    '           -- chain the shipped producer used — day and time, then the trainer''s first name,' || E'\n' ||
    '           -- then the location, then a number that skips what the round already holds.' || E'\n' ||
    '           public.rebook_round_sanitize_copy(' || E'\n' ||
    '             (SELECT (public.d7_child_target_names(' || E'\n' ||
    '                        v_eff_label,' || E'\n' ||
    '                        ARRAY(SELECT z::text FROM unnest(n.ids) AS z),' || E'\n' ||
    '                        n.ws, n.ts,' || E'\n' ||
    '                        public.d7_p_first_names(n.trn),' || E'\n' ||
    '                        public.d7_p_location_names(n.loc),' || E'\n' ||
    '                        public.d7_p_taken_names(p_academy, p_round_id, v_eff_start)))' || E'\n' ||
    '                     [array_position(n.ids, ch.child_cycle_id)]' || E'\n' ||
    '                FROM nmin n), 300) AS target_name';
  v_old_cte   CONSTANT text := '  named AS (';
  v_new_cte   CONSTANT text :=
    '  nmin AS (' || E'\n' ||
    '    -- D7 (20261203200000): the naming chain''s inputs, gathered ONCE over the whole coherent' || E'\n' ||
    '    -- child set. A name collision is a CROSS-CHILD property, so no per-row expression can' || E'\n' ||
    '    -- decide a name; the arrays below are what the chain is a function of. Ordered by the' || E'\n' ||
    '    -- child id under the C collation, which is the order every other array in this statement' || E'\n' ||
    '    -- already uses, so `array_position` lines up with it.' || E'\n' ||
    '    SELECT array_agg(ch.child_cycle_id ORDER BY ch.child_cycle_id::text COLLATE "C") AS ids,' || E'\n' ||
    '           array_agg(ch.local_weekday  ORDER BY ch.child_cycle_id::text COLLATE "C") AS ws,' || E'\n' ||
    '           array_agg(ch.local_time     ORDER BY ch.child_cycle_id::text COLLATE "C") AS ts,' || E'\n' ||
    '           array_agg(ch.trainer_id     ORDER BY ch.child_cycle_id::text COLLATE "C") AS trn,' || E'\n' ||
    '           array_agg(ch.location_id    ORDER BY ch.child_cycle_id::text COLLATE "C") AS loc' || E'\n' ||
    '      FROM ch WHERE ch.coherent' || E'\n' ||
    '  ),' || E'\n' ||
    '  named AS (';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regprocedure('public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[])') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the selection authority)';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  SELECT p.proowner::regrole::name INTO v_a
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.rebook_round_preview_normalized_core(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])');
  IF v_a IS NULL OR v_p IS NULL OR v_a = v_p THEN
    RAISE EXCEPTION 'D7 human names: the two domain owners did not resolve distinctly (A=%, P=%)', v_a, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_a, 'MEMBER')
     OR NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 human names: % is not a member of both domain owners', current_user;
  END IF;

  -- ── (1) THE THREE ARRAY-SHAPED NAME INPUTS ────────────────────────────────────────────────
  --
  -- Domain-P, because every one of them reads a product relation, and ALIGNED with their input
  -- array so the chain's six arrays index together. `d7_p_display_names` is the underlying read;
  -- these three only shape it.
  CREATE FUNCTION public.d7_p_first_names(p_trainer_ids uuid[])
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $fn$
    -- FIRST NAME ONLY, exactly as the legacy chain used it.
    SELECT ARRAY(SELECT (SELECT split_part(d.display_name, ' ', 1)
                           FROM public.d7_p_display_names(p_trainer_ids, ARRAY[]::uuid[]) d
                          WHERE d.kind = 'trainer' AND d.subject_id = t)
                   FROM unnest(coalesce(p_trainer_ids, ARRAY[]::uuid[])) AS t)
  $fn$;

  CREATE FUNCTION public.d7_p_location_names(p_location_ids uuid[])
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $fn$
    SELECT ARRAY(SELECT (SELECT d.display_name
                           FROM public.d7_p_display_names(ARRAY[]::uuid[], p_location_ids) d
                          WHERE d.kind = 'location' AND d.subject_id = l)
                   FROM unnest(coalesce(p_location_ids, ARRAY[]::uuid[])) AS l)
  $fn$;

  CREATE FUNCTION public.d7_p_taken_names(p_academy uuid, p_round uuid, p_start date)
  RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $fn$
    SELECT coalesce(array_agg(DISTINCT n.name), ARRAY[]::text[])
      FROM public.d7_p_round_taken_names(p_academy, p_round, p_start) n
  $fn$;

  EXECUTE format('ALTER FUNCTION public.d7_p_first_names(uuid[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_location_names(uuid[]) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_taken_names(uuid,uuid,date) OWNER TO %I', v_p);
  REVOKE ALL ON FUNCTION public.d7_p_first_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_location_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_taken_names(uuid,uuid,date) FROM PUBLIC, anon, authenticated, service_role;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_first_names(uuid[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_location_names(uuid[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_taken_names(uuid,uuid,date) TO %I', v_a);
  -- The naming chain itself is called from inside the A-owned cores, so A must reach it too.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_child_target_names(text,text[],int[],time[],text[],text[],text[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_series_label(int,time) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_name_counts(text[]) TO %I', v_a);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_name_colliding(jsonb,text,text[]) TO %I', v_a);

  -- ── (2) THE TWO SUBSTITUTIONS, PER CORE ───────────────────────────────────────────────────
  FOREACH v_core IN ARRAY ARRAY[
    'public.rebook_round_preview_normalized_core(uuid,uuid,text,text,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[])',
    'public.rebook_round_apply_normalized_core(uuid,uuid,text,text,uuid,uuid,int,text,date,date,int,int,int,text,boolean,text,boolean,boolean,numeric,boolean,int,text,text,text,text,text,text,date[],date[],text[],uuid[],uuid[],uuid[],bytea)'
  ] LOOP
    v_ident := v_core;
    IF to_regprocedure(v_ident) IS NULL THEN
      RAISE EXCEPTION 'D7 human names: % is not installed', v_ident;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
      INTO v_before FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_ident);

    -- EXACTLY ONE OCCURRENCE OF EACH ANCHOR, asserted before anything is rewritten. A second
    -- occurrence would mean this file is guessing which one to change.
    IF (length(v_src) - length(replace(v_src, v_old_expr, ''))) / length(v_old_expr) <> 1 THEN
      RAISE EXCEPTION 'D7 human names: % does not carry EXACTLY ONE reviewed target_name rendering', v_ident;
    END IF;
    IF (length(v_src) - length(replace(v_src, v_old_cte, ''))) / length(v_old_cte) <> 1 THEN
      RAISE EXCEPTION 'D7 human names: % does not carry EXACTLY ONE `named` CTE anchor', v_ident;
    END IF;

    v_new := replace(replace(v_src, v_old_expr, v_new_expr), v_old_cte, v_new_cte);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'D7 human names: the rewrite of % changed nothing', v_ident;
    END IF;
    EXECUTE v_new;

    -- POST-CONDITIONS: the new rendering is installed, the old one is gone, and the body is not
    -- byte-identical to what it was.
    SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
      INTO v_after FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_ident);
    IF v_after = v_before THEN
      RAISE EXCEPTION 'D7 human names: % still carries its previous body after the rewrite', v_ident;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid = to_regprocedure(v_ident)
                      AND p.prosrc LIKE '%d7_child_target_names%'
                      AND p.prosrc LIKE '%nmin AS (%'
                      AND p.prosrc NOT LIKE '%|| '' · '' || coalesce(ch.trainer_id::text, ''notrn'')%') THEN
      RAISE EXCEPTION 'D7 human names: % did not end up with the replacement rendering', v_ident;
    END IF;
    -- OWNERSHIP IS UNCHANGED BY `CREATE OR REPLACE`, and that is asserted rather than assumed:
    -- an A core that came back owned by the applying role would be a privilege change nobody
    -- asked for.
    IF (SELECT p.proowner::regrole::name FROM pg_catalog.pg_proc p
         WHERE p.oid = to_regprocedure(v_ident)) <> v_a THEN
      RAISE EXCEPTION 'D7 human names: % changed owner during the rewrite', v_ident;
    END IF;
    RAISE NOTICE 'D7: % re-issued with the legacy naming chain (% -> %)', v_ident, left(v_before, 16), left(v_after, 16);
  END LOOP;
END $d7_human_names$;
