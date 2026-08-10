-- SLICE A part 3 — the identity sender's invocation mechanism, REGISTERED BUT INACTIVE.
--
-- Codex round 1 of slice A: the sender was request-driven only. Nothing invoked it, so once the
-- challenge-producing entrypoints shipped, verification rows would have sat `pending` forever while
-- the runbook said "activate the sender" with no executable action attached. A queue with no drainer
-- is a slower version of the bug this slice exists to fix.
--
-- This deliberately follows `20261012100000_notif_10cb_digest_cron_inert.sql` rather than the older
-- armed worker crons. Round 2 caught three ways the armed pattern is wrong for an inert job, and the
-- digest migration had already solved all three; the reasoning below is its reasoning, applied here.
--
-- ACTIVATION (owner-gated, at the cutover, AFTER the secrets are set):
--     SELECT cron.alter_job((SELECT jobid FROM cron.job
--                             WHERE jobname = 'notification-identity-worker' AND username = current_user),
--                           active => true);
-- DEACTIVATION (the rollback): the same statement with active => false.
DO $do$
DECLARE
  sr_key text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-identity-worker registration';
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO sr_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  -- NO VAULT GUARD — install anyway. The armed worker crons skip when the secret is missing, which
  -- is right for them: they would otherwise tick with no bearer. This job is created DISABLED and
  -- its stored command reads Vault at TICK time, so skipping would be actively harmful: on a
  -- restore where migrations run before out-of-band secrets, the migration would be recorded as
  -- applied and adding the key later would never create the job. The rollout would report
  -- "installed inactive" over nothing at all. (Round 2, P2.)
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — installing notification-identity-worker INACTIVE anyway (the command reads Vault at tick time)';
  END IF;

  -- IDEMPOTENT AND NON-DESTRUCTIVE. The first draft of this migration unscheduled and rescheduled,
  -- copying the armed workers. That is wrong here: re-applying after the cutover would have replaced
  -- an ACTIVE sender with an INACTIVE one and silently stopped identity mail, with the rollout still
  -- reporting success. An existing job is left exactly as the owner left it. (Round 2, P1.)
  --
  -- The advisory lock serializes check-then-create: pg_cron's named `cron.schedule` UPDATES an
  -- existing job of the same name rather than failing, so an unserialized check could see "absent",
  -- then update a job a concurrent apply had just created, and disable it.
  PERFORM pg_advisory_xact_lock(hashtextextended('cron:notification-identity-worker', 0));

  -- OWNER-SCOPED. pg_cron scopes named-job uniqueness by (jobname, username), so a bare jobname
  -- lookup can see — and act on — another role's job of the same name.
  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'notification-identity-worker' AND username = current_user;
  IF v_jobid IS NOT NULL THEN
    RAISE NOTICE 'notification-identity-worker already scheduled (jobid %) — leaving its active state untouched', v_jobid;
    RETURN;
  END IF;

  -- Every 2 minutes once enabled, matching the generic email worker: a verification challenge is the
  -- one email a person is actively waiting on with a booking half-finished, so latency here is the
  -- product.
  --
  -- The jobid comes from cron.schedule's OWN return value, never from a re-lookup by name: a
  -- re-lookup could select a different role's job created in between, disable THAT one, and leave
  -- the job this migration just created armed — the exact opposite of the intent.
  --
  -- EVERY RESOLVABLE NAME IN THIS COMMAND IS SCHEMA-QUALIFIED — functions, BOTH operators, and the
  -- cast. A cron job runs under its owner's search_path, which by default still contains `public`,
  -- and function resolution does NOT prefer pg_catalog: an exact-arity, exact-type overload beats
  -- pg_catalog's VARIADIC "any" wherever its schema sits in the path. So a
  -- `public.jsonb_build_object(text,text,text,text)` would receive the already-decrypted
  -- service_role bearer as an argument on the very next tick and could exfiltrate it while returning
  -- plausible headers. The same applies to both operators: `||` builds the header value and `=`
  -- selects the Vault row, and a hostile (text,text) equality runs with the cron owner's privileges
  -- inside a query over vault.decrypted_secrets. Ordering the search_path does not help; only
  -- qualifying does. (Round 2, P1.)
  v_jobid := cron.schedule('notification-identity-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-identity-worker',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' OPERATOR(pg_catalog.||) (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name OPERATOR(pg_catalog.=) 'service_role_key')
      ),
      body := '{}'::pg_catalog.jsonb
    ) AS request_id;
  $cmd$);

  -- INERT BY CONSTRUCTION: disabled in the same transaction that created it, so there is no window
  -- in which a scheduler tick could fire it.
  PERFORM cron.alter_job(v_jobid, active := false);
  RAISE NOTICE 'Scheduled notification-identity-worker every 2 minutes, INACTIVE (jobid %)', v_jobid;
END $do$;
