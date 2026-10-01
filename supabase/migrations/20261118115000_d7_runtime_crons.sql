-- D7 RUNTIME — SCHEDULING. Retires the legacy member-open cron and installs the three D7 runtime
-- jobs, ALL INACTIVE.
--
-- THIS FILE SORTS BEFORE ABC-27 ON PURPOSE (see the ordering note below). It creates no schema
-- object, reads nothing ABC-27 defines, and activates nothing.
--
-- This file does exactly four things and nothing else:
--
--   (a) unschedules EXACTLY ONE job, `notify-rebook-member-open`, whose edge function this release
--       deletes and whose first RPC the ABC-27 migration — applied immediately AFTER this one —
--       revokes from `service_role`. Left armed, it would 404 (function gone) and then, once
--       ABC-27 lands, 500 on a `42501` every fifteen minutes forever. `auto-rebook-reminder` is
--       scheduled by the SAME historical DO block and STAYS: this file names it nowhere.
--   (b)(c)(d) install `rebook-member-open-worker` (*/2), `rebook-round-materializer` (*/5) and
--       `rebook-member-open-janitor` (*/10), each created and DISABLED IN THE SAME TRANSACTION.
--
-- NOTHING HERE ARMS ANYTHING. Enabling a job is `cron.alter_job(jobid, active := true)` and is an
-- owner gate performed from the runbook, after the deploy, per job. The dispatcher additionally
-- needs its `REBOOK_MEMBER_OPEN_SEND_ENABLED` edge environment variable set, which is a SECOND and
-- independent gate: an armed dispatcher with the flag absent returns 200 {"status":"disabled"}
-- having made zero database calls.
--
-- ── WHY THIS FILE SORTS *BEFORE* ABC-27, AND CARRIES NO PREREQUISITE GUARD ───────────────────
--
-- Version `20261118115000` places this file between `20261118110000` and the ABC-27 authority
-- migration at `20261118120000`. That ordering is the safety property, not a formality.
--
-- The legacy job's FIRST call is `rebook_cycles_needing_member_open_notice()`, whose EXECUTE
-- ABC-27 revokes from `service_role`. If ABC-27 applied while that job was still armed, every tick
-- would raise `42501` and page an operator every fifteen minutes, forever. Encoding "retire the
-- cron first" as a filename that sorts earlier makes `supabase db push` enforce the order by
-- construction — an operator cannot get it wrong, and no runbook step has to be remembered.
--
-- IT DEPENDS ON NOTHING ABC-27 CREATES, so it carries NO prerequisite guard. Every object it
-- touches — `pg_extension`, `cron.job`, `vault.decrypted_secrets` — predates ABC-27 by months. The
-- three jobs it installs POINT AT functions that are deployed separately and are inert until armed,
-- which is a deploy-time fact and not a schema dependency. A guard here would be a fail-open with
-- nothing to protect: it could only ever make a correct migration silently do nothing.
--
-- (Its sibling `20261119120000_d7_retire_member_open_surfaces.sql` is the opposite case: it reads
-- `notification_outbox.transport_state`, which ONLY ABC-27 creates, so it sorts after ABC-27 and
-- does carry the guard — paid for by an explicit not-silently-skipping control.)
--
-- ── WHAT IS COPIED FROM `20261012100000_notif_10cb_digest_cron_inert.sql`, AND WHY ────────────
--
-- That file is the reviewed inactive-cron template and every element of it is load-bearing:
--
--   * a `pg_cron` guard, but deliberately NO Vault guard. The job is created DISABLED and its
--     stored command reads the secret at TICK time, so skipping on a missing secret would record
--     this migration as applied over nothing — on a restore where migrations run before
--     out-of-band secrets, adding the key later would never create the job.
--   * `pg_advisory_xact_lock` per job name. Real pg_cron's NAMED `cron.schedule` UPDATES an
--     existing job rather than failing, so an unserialised check-then-create could see "absent",
--     then update a job a concurrent apply had just created, and disable it.
--   * an OWNER-SCOPED existence check (`username = current_user`), because real pg_cron scopes
--     named-job uniqueness by (jobname, username) — a bare name lookup can see another role's job.
--     An existing job is LEFT EXACTLY AS THE OWNER LEFT IT, active or not: this whole unit exists
--     so an owner decides when these run, and an unschedule/reschedule would silently disarm a job
--     they had already enabled.
--   * the jobid taken from `cron.schedule`'s OWN return value, never a re-lookup by name — a
--     re-lookup could select a different role's job created in between and disable THAT one,
--     leaving the job this migration created armed.
--   * EVERY RESOLVABLE NAME IN EACH COMMAND SCHEMA-QUALIFIED: functions, BOTH operators (`||`
--     builds the header value, `=` selects the Vault row) and the `::jsonb` cast. A cron job runs
--     under its owner's `search_path`, which by default still contains `public`, and function
--     resolution does NOT prefer `pg_catalog`: an exact-arity, exact-type overload beats
--     `pg_catalog`'s VARIADIC "any" wherever its schema sits in the path, INCLUDING after an
--     explicit `pg_catalog`. So an unqualified `jsonb_build_object(text,text,text,text)` in
--     `public` would receive the already-decrypted service-role bearer as an argument on the very
--     next tick. Ordering the path does not help; only qualifying does. The exhaustive check is
--     `scripts/rollout/notif-10cb/verify/preflight-pg.mjs`, which compares the STORED PARSE TREE
--     under an empty search_path against the same tree built with a hostile schema first.
--   * `cron.alter_job(v_jobid, active := false)` in the SAME transaction that created the job, so
--     there is no window in which a scheduler tick could fire it.

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (a) RETIRE THE LEGACY MEMBER-OPEN CRON — exactly one job, owner-scoped.
DO $do$
DECLARE
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notify-rebook-member-open unschedule';
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cron:notify-rebook-member-open', 0));

  -- OWNER-SCOPED, for the same reason the installs below are: a bare jobname lookup can see, and
  -- unschedule, another role's job of the same name.
  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'notify-rebook-member-open' AND username = current_user;
  IF v_jobid IS NULL THEN
    RAISE NOTICE 'notify-rebook-member-open is not scheduled for % — nothing to retire', current_user;
  ELSE
    -- THE LITERAL NAME, GUARDED BY THE OWNER-SCOPED LOOKUP ABOVE.
    --
    -- Passing `v_jobid` instead is tempting — the id came from a lookup that already filtered on
    -- `username = current_user`, so it cannot name another role's job. It was rejected because it
    -- costs more than it buys: TWO static guards in this repository read cron job names as QUOTED
    -- STRING LITERALS and are blind to a numeric argument —
    -- `src/test/reviewedCronJobsRegister.test.ts` (which treats an unreadable form as a HOLE, not a
    -- pass) and `scripts/check-legacy-service-role-consumers.mjs`'s SQL lifecycle check. A jobid
    -- call makes this retirement invisible to both, which is a real and permanent loss of coverage
    -- over a job whose retirement is load-bearing.
    --
    -- The safety the jobid form offered is retained anyway: this branch is reached ONLY when the
    -- owner-scoped lookup found OUR job, and real pg_cron's unschedule-by-name is itself scoped to
    -- the calling role's jobs. (Written without the parenthesised signature on purpose — the
    -- register's scanner reads comments as well as code, and a signature spelled out here would
    -- read as an unschedule call with an unreadable job name.)
    PERFORM cron.unschedule('notify-rebook-member-open');
    RAISE NOTICE 'Unscheduled notify-rebook-member-open (jobid %) — its edge function is deleted and its first RPC loses service_role EXECUTE under ABC-27', v_jobid;
  END IF;
END $do$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (b) THE TRANSPORT DISPATCHER — every 2 minutes once enabled. INACTIVE.
--
-- Two minutes is the same cadence the notification email worker already runs at, and the worker is
-- bounded per invocation (8 rows, a 25 s budget), so a backlog costs extra ticks rather than a
-- longer invocation.
DO $do$
DECLARE
  sr_key  text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping rebook-member-open-worker schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — installing rebook-member-open-worker INACTIVE anyway (the command reads Vault at tick time)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cron:rebook-member-open-worker', 0));

  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'rebook-member-open-worker' AND username = current_user;
  IF v_jobid IS NOT NULL THEN
    RAISE NOTICE 'rebook-member-open-worker already scheduled (jobid %) — leaving its active state untouched', v_jobid;
    RETURN;
  END IF;

  v_jobid := cron.schedule('rebook-member-open-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/rebook-member-open-worker',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' OPERATOR(pg_catalog.||) (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name OPERATOR(pg_catalog.=) 'service_role_key')
      ),
      body := '{}'::pg_catalog.jsonb
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(v_jobid, active := false);
  RAISE NOTICE 'Scheduled rebook-member-open-worker every 2 minutes, INACTIVE (jobid %)', v_jobid;
END $do$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (c) THE ROUND MATERIALIZER — every 5 minutes once enabled. INACTIVE.
--
-- Five minutes because a member window opens on a schedule measured in days, and the materializer
-- pages (3 rounds x 500 recipients) with an explicit `has_more` the next tick picks up.
DO $do$
DECLARE
  sr_key  text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping rebook-round-materializer schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — installing rebook-round-materializer INACTIVE anyway (the command reads Vault at tick time)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cron:rebook-round-materializer', 0));

  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'rebook-round-materializer' AND username = current_user;
  IF v_jobid IS NOT NULL THEN
    RAISE NOTICE 'rebook-round-materializer already scheduled (jobid %) — leaving its active state untouched', v_jobid;
    RETURN;
  END IF;

  v_jobid := cron.schedule('rebook-round-materializer', '*/5 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/rebook-round-materializer',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' OPERATOR(pg_catalog.||) (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name OPERATOR(pg_catalog.=) 'service_role_key')
      ),
      body := '{}'::pg_catalog.jsonb
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(v_jobid, active := false);
  RAISE NOTICE 'Scheduled rebook-round-materializer every 5 minutes, INACTIVE (jobid %)', v_jobid;
END $do$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- (d) THE TRANSPORT JANITOR — every 10 minutes once enabled. INACTIVE.
--
-- Ten minutes, and on its OWN schedule rather than inside the dispatcher's, because a wedged
-- dispatcher must not be able to block the path that un-wedges it. Its stale-lease threshold is 15
-- minutes, so a lease is examined by at least one tick before it is old enough to recover.
DO $do$
DECLARE
  sr_key  text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping rebook-member-open-janitor schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — installing rebook-member-open-janitor INACTIVE anyway (the command reads Vault at tick time)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cron:rebook-member-open-janitor', 0));

  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'rebook-member-open-janitor' AND username = current_user;
  IF v_jobid IS NOT NULL THEN
    RAISE NOTICE 'rebook-member-open-janitor already scheduled (jobid %) — leaving its active state untouched', v_jobid;
    RETURN;
  END IF;

  v_jobid := cron.schedule('rebook-member-open-janitor', '*/10 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/rebook-member-open-janitor',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' OPERATOR(pg_catalog.||) (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name OPERATOR(pg_catalog.=) 'service_role_key')
      ),
      body := '{}'::pg_catalog.jsonb
    ) AS request_id;
  $cmd$);

  PERFORM cron.alter_job(v_jobid, active := false);
  RAISE NOTICE 'Scheduled rebook-member-open-janitor every 10 minutes, INACTIVE (jobid %)', v_jobid;
END $do$;
