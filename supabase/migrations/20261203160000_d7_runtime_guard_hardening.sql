-- D7 RUNTIME — TWO GUARDS THAT TRUSTED A NAME AND SHOULD HAVE CHECKED A VALUE.
--
-- ROUND-4 P2-5 AND P2-8. Both predecessors are already issued and are superseded rather than
-- amended, so this file re-validates what they installed and refuses if it is not what was reviewed.
--
-- ── P2-5 · A PRE-EXISTING CRON ROW WAS ADOPTED WITHOUT READING ITS COMMAND ───────────────────
--
-- `20261118115000` exits early when a job of the same name already exists under the same user, on
-- the reasoning that an owner may have armed it deliberately and its active state must not be
-- disturbed. That is right about the SCHEDULE and wrong about the COMMAND: the row it adopts keeps
-- whatever SQL it already carried, and that SQL is handed the Vault service-role bearer at every
-- tick. "A job by this name exists" is not evidence that the job does what this release reviewed.
--
-- The digests below are of the reviewed command text with runs of whitespace collapsed, taken from
-- `20261118115000` itself. Whitespace is normalised because pg_cron stores the command as written
-- and an indentation change is not a semantic one; nothing else is forgiven.
--
-- ── P2-8 · THE INDEX GUARD ACCEPTED ANY DEFINITION CONTAINING THE RIGHT WORDS ────────────────
--
-- `20261203110000` checks the deparsed index definition with `strpos` against a handful of tokens.
-- The reviewed predicate with `AND false` appended contains every one of those tokens, is valid,
-- live and non-unique, and serves no rows at all. A pre-existing same-named index — the invalid
-- leftover of a `CREATE INDEX CONCURRENTLY` the runbook itself suggests, or a hand-made one — is
-- exactly the case that guard exists for and exactly the case it cannot judge. The whole rendered
-- definition and the predicate's own expression tree are compared here instead.

DO $d7_guard_hardening$
DECLARE
  v_job     record;
  v_count   int;
  v_norm    text;
  v_digest  text;
  v_def     text;
  v_pred    text;
  -- job name, schedule, sha256 of the reviewed command with whitespace collapsed
  v_expect  CONSTANT text[][] := ARRAY[
    ARRAY['rebook-member-open-worker', '*/2 * * * *',
          'bb4f86a4a629f31bfdf34940cd9983c0adde6ed7422020c69ef7afb005ae323a'],
    ARRAY['rebook-round-materializer', '*/5 * * * *',
          '2ab2d7f54e44ffcb59f8e2b94f60a94b67c8b9073ae91094ddef7c30bb22a45b'],
    ARRAY['rebook-member-open-janitor', '*/10 * * * *',
          '8f86ec9406aadfda4bde219331910ec8e925e5d98442550770835359f56c32fb']
  ];
  v_row     text[];
  v_idx     CONSTANT text := 'public.idx_notification_outbox_d7_member_open_claim';
  v_want_def  CONSTANT text :=
    'CREATE INDEX idx_notification_outbox_d7_member_open_claim ON public.notification_outbox '
    || 'USING btree (scheduled_for, id) WHERE ((event_type = ''rebook_member_open_player''::text) '
    || 'AND (channel = ''email''::text) AND (transport_state = ANY (ARRAY[''queued''::text, '
    || '''retry_wait''::text, ''quiet_hours_deferred''::text, ''channel_kill_deferred''::text])))';
  v_want_pred CONSTANT text :=
    '((event_type = ''rebook_member_open_player''::text) AND (channel = ''email''::text) '
    || 'AND (transport_state = ANY (ARRAY[''queued''::text, ''retry_wait''::text, '
    || '''quiet_hours_deferred''::text, ''channel_kill_deferred''::text])))';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27)';
    RETURN;
  END IF;

  -- ── P2-5 ────────────────────────────────────────────────────────────────────────────────
  --
  -- ALL THREE OR NONE, AND NOTHING IN BETWEEN. If none of the D7 jobs exists, the cron migration
  -- has not been applied in this database and there is nothing here to validate — that is the
  -- counterfactual the evidence suite builds deliberately, not a state to refuse. If SOME exist,
  -- the installation is partial and this guard refuses rather than validating the survivors and
  -- reporting success over a half-installed schedule.
  SELECT count(*)::int INTO v_count
    FROM cron.job j
   WHERE j.jobname IN ('rebook-member-open-worker', 'rebook-round-materializer',
                       'rebook-member-open-janitor');
  IF v_count = 0 THEN
    RAISE NOTICE 'D7 guard: no D7 cron job present — the cron migration has not run in this database, nothing to validate';
  ELSIF v_count <> 3 THEN
    RAISE EXCEPTION 'D7 guard: % of the 3 D7 cron jobs exist — a partial schedule is not a state this file will bless', v_count
      USING HINT = 'Re-apply 20261118115000_d7_runtime_crons.sql, or remove the partial rows, before applying this guard.';
  END IF;

  FOREACH v_row SLICE 1 IN ARRAY v_expect LOOP
    CONTINUE WHEN v_count = 0;
    SELECT j.jobname, j.schedule, j.command, j.active, j.username
      INTO v_job
      FROM cron.job j
     WHERE j.jobname = v_row[1];

    IF NOT FOUND THEN
      RAISE EXCEPTION 'D7 guard: cron job % is absent while its siblings are present', v_row[1];
    END IF;

    IF v_job.schedule IS DISTINCT FROM v_row[2] THEN
      RAISE EXCEPTION 'D7 guard: cron job % runs at "%" but the reviewed cadence is "%"',
        v_row[1], v_job.schedule, v_row[2];
    END IF;

    v_norm   := btrim(regexp_replace(coalesce(v_job.command, ''), '\s+', ' ', 'g'));
    v_digest := encode(pg_catalog.sha256(pg_catalog.convert_to(v_norm, 'UTF8')), 'hex');
    IF v_digest IS DISTINCT FROM v_row[3] THEN
      RAISE EXCEPTION 'D7 guard: cron job % carries an unreviewed command (digest % , expected %)',
        v_row[1], v_digest, v_row[3]
        USING HINT = 'A job of this name already existed and was adopted without its SQL being read. It receives the Vault service-role bearer at every tick. Inspect cron.job.command, then unschedule it and re-apply 20261118115000.';
    END IF;

    -- ACTIVATION STAYS THE OWNER'S. This file validates WHAT would run, never WHETHER it runs, and
    -- it deliberately does not read or change `active`.
    RAISE NOTICE 'D7 guard: cron job % carries the reviewed command', v_row[1];
  END LOOP;

  -- ── P2-8 ────────────────────────────────────────────────────────────────────────────────
  IF to_regclass(v_idx) IS NULL THEN
    RAISE EXCEPTION 'D7 guard: % is absent — 20261203110000 should have created it', v_idx;
  END IF;

  SELECT pg_catalog.pg_get_indexdef(i.indexrelid),
         pg_catalog.pg_get_expr(i.indpred, i.indrelid)
    INTO v_def, v_pred
    FROM pg_catalog.pg_index i
   WHERE i.indexrelid = to_regclass(v_idx)
     AND i.indrelid = to_regclass('public.notification_outbox')
     AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'D7 guard: % is not a valid, live, non-unique index on public.notification_outbox', v_idx
      USING HINT = 'The most likely cause is the INVALID leftover of a failed CREATE INDEX CONCURRENTLY, which CREATE INDEX IF NOT EXISTS skips silently. Drop it and re-apply 20261203110000.';
  END IF;

  IF v_def IS DISTINCT FROM v_want_def THEN
    RAISE EXCEPTION 'D7 guard: % is not the reviewed index. Installed: %', v_idx, v_def
      USING HINT = 'A same-named index with the reviewed tokens but a different meaning — an inverted channel test, or the predicate with AND false — passes a substring check and serves no rows. Rename or drop it, then re-apply 20261203110000.';
  END IF;

  -- The predicate is read from its own expression tree as well, so the partiality is proved by the
  -- catalog rather than by parsing the rendered DDL a second time.
  IF v_pred IS DISTINCT FROM v_want_pred THEN
    RAISE EXCEPTION 'D7 guard: %''s predicate is not the reviewed one. Installed: %', v_idx, v_pred;
  END IF;

  RAISE NOTICE 'D7 guard: the claim index is exactly the reviewed partial index';
END $d7_guard_hardening$;
