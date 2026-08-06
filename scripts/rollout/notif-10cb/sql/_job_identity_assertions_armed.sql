-- N7 POSTFLIGHT — the job-identity assertions with the ARMED expectation.
--
-- Generated from _job_identity_assertions.sql by hand ONCE and pinned by
-- src/test/notif10cbActivationPreflight.test.ts: the two files must differ in exactly the
-- active-state assertion and nothing else, so a hardening added to one can never quietly miss the
-- other. It also materialises the job row itself, because postflight is not inside an arming
-- transaction and has no caller to do it.
DROP TABLE IF EXISTS pg_temp._gate_job;
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user;

-- 10c-b — THE JOB IS THE REVIEWED JOB. Shared by the activation gate and by `assert-inert`, which
-- runs BEFORE any switch is enabled.
--
-- Splitting this out closed a real window. The F migration deliberately preserves an existing
-- job's active state, and inactivity was only asserted at PREFLIGHT — i.e. after the engine and the
-- edge switch were on and after the manual canary invocation. A job left ARMED by an earlier
-- rollout would therefore have ticked as soon as the engine went live, dispatching to the whole
-- population before the controlled canary and before the monitor was watching.
--
-- Requires pg_temp._gate_job to have been resolved by the caller.
-- Every relation here is SCHEMA-QUALIFIED, `pg_temp._gate_job` included. An unqualified name is
-- resolved through search_path, and search_path can be set per role or per database — which the
-- client-side PG* stripping cannot touch. With `search_path = hostile, pg_temp, public` a permanent
-- `hostile._gate_job` resolves BEFORE the temp table, and a view that returns a reviewed jobid to
-- the hash assertions and a different one to the arm puts the arbitrary-job problem straight back.
--
-- EVERY cron.job READ BELOW GOES THROUGH `_gate_job`, the ONE row the caller resolved (and, in
-- activate.sql, LOCKED) before including this file. Re-looking the job up by name in each assertion
-- was unsound: under READ COMMITTED every statement takes a fresh snapshot, so a job that was absent
-- when the lock was attempted — locking nothing — could be inserted by another session and then
-- satisfy the later assertions, and a job altered between two assertions would be checked in one and
-- armed in the other. The caller materialises the row once; this file never widens that.
--
-- 1. the job must EXIST and still be INACTIVE. Arming an already-armed job is not idempotent
--    reassurance — it means someone else armed it, and the runbook's sequencing assumption
--    (switch on, canary reconciled, THEN arm) no longer holds.
SELECT pg_temp.assert_eq((SELECT count(*)::int FROM pg_temp._gate_job), 1,
  'the digest cron job exists (exactly one, owned by the current user)');
-- 1a. ...and that jobid still carries the resolved NAME and OWNER.
--
-- INTEGRATION GAP, found by composing N0 with N4–N7 and by the pin below. N0 added this re-check
-- to the pre-activation file; this armed variant was generated from the pre-N0 copy, so the two
-- files had drifted apart by more than the state assertion — and the side that lost the check was
-- the POST-activation one, where a re-pointed or re-owned job matters most. Restored verbatim, so
-- the two files differ in exactly the state check again. This is precisely the class of defect a
-- unit reviewed only against its own base cannot see.
SELECT pg_temp.assert(
  (SELECT jobname = 'notification-digest-worker' AND username = current_user
     FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the resolved jobid is still the notification-digest-worker job owned by the current user');
-- POSTFLIGHT VARIANT: after activation the job must be ARMED. Everything else in this file is
-- byte-identical to the pre-activation assertions, because the identity question does not change
-- when the answer to the state question does: the command a tick executes still posts a
-- Vault-decrypted bearer to whatever url it names, and "it was the reviewed job when we armed it"
-- is not a claim about what it is now.
SELECT pg_temp.assert((SELECT active FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the digest cron is ARMED (postflight runs after activation — an inactive job here means someone disarmed it)');
-- ...and the liveness read a monitor uses must agree with the row we resolved. If these two ever
-- disagree, the job the monitor watches is not the job about to be armed.
SELECT pg_temp.assert((SELECT job_present FROM public.notif_digest_worker_liveness()),
  'the liveness read agrees that the digest cron job exists');

-- 1b. ...and it must be THE REVIEWED JOB, not merely a job of that name.
--
-- THIS IS THE ONE THAT ARMS CREDENTIAL EXFILTRATION IF IT IS MISSING. The F migration
-- deliberately does NOT overwrite an existing job of this name (an unschedule/reschedule would
-- silently disarm an activation the owner had already performed), so whatever job is present may
-- have been created by something other than the reviewed migration — an older revision, a hand
-- edit, a restore from a different project, or an attacker with SQL access. Its stored command is
-- what a tick EXECUTES, and that command posts a Vault-decrypted service_role bearer token to
-- whatever url it names. Arming a job whose command we have not verified is arming that.
--
-- Presence + inactivity say nothing about any of this, so the identity of the job is checked
-- along every axis a tick actually uses: WHEN it fires, WHICH database it fires in, WHO owns it,
-- and WHAT it runs.
--
-- The specific checks come first because they name the exact problem; the whole-command equality
-- at the end is the authority. It is deliberately brittle: this is an activation gate, and a
-- command that no longer matches the reviewed text must stop the rollout and be re-reviewed, not
-- be waved through because it still "looks about right".
-- (scripts/../src/test/notif10cbActivationPreflight.test.ts pins these literals to the migration,
-- so the two cannot drift apart silently.)

-- owner-scoped, exactly as pg_cron scopes named-job uniqueness by (jobname, username)
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)), 1,
  'exactly one notification-digest-worker job is owned by the current user');

SELECT pg_temp.assert_eq(
  (SELECT schedule::text FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  '*/5 * * * *'::text,
  'the cron schedule is the reviewed one (a drifted schedule is a different rollout)');

-- The job runs in whichever database cron.job.database names, NOT necessarily the one we are
-- connected to. A job pointed at another database would tick somewhere this preflight never looked.
SELECT pg_temp.assert_eq(
  (SELECT database::text FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  current_database()::text,
  'the cron job runs in THIS database (a job bound to another database ticks somewhere this preflight cannot see)');

-- WHICH SERVER the job runs against. pg_cron dispatches a job to (nodename, nodeport), so a job
-- whose node fields were changed executes somewhere else entirely while its schedule, database,
-- username and command all still read as the reviewed ones — the whole command hash included. The
-- repo's own cron fingerprint already treats both fields as behaviour-bearing
-- (scripts/rollout/notif-10ca3/sql/_cron_fp.sql). 'localhost' + this server's own port is what a
-- normally-scheduled job carries; anything else has been re-pointed and must be re-reviewed, not
-- armed. (current_setting('port') is the backend's listen port, so this is correct when connecting
-- through the pooler too.)
SELECT pg_temp.assert_eq(
  (SELECT nodename::text FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'localhost'::text,
  'the cron job executes on THIS node (a re-pointed nodename runs the command against another server)');
SELECT pg_temp.assert_eq(
  (SELECT nodeport::int FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  current_setting('port')::int,
  'the cron job executes on THIS port (a re-pointed nodeport runs the command against another server)');

-- The endpoint. Asserted independently of the full-text match so the failure message names the
-- actual danger, and so this survives a legitimate future re-wording of the command.
SELECT pg_temp.assert(
  (SELECT command LIKE '%https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker%'
     FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the cron command posts to the reviewed notification-digest-worker endpoint');

-- ...and NOTHING else. A second url in the same command is how the bearer leaves: the reviewed
-- post happens, looks healthy, and a second one ships the same header elsewhere.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM (
     SELECT regexp_matches(command, 'https?://[^'' ]+', 'g') AS u
       FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)) s
   WHERE s.u[1] <> 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'the cron command names NO url other than the reviewed endpoint');

-- The bearer must be read from Vault AT TICK TIME. A command carrying an inline credential means
-- the secret is sitting in cron.job in plaintext, readable by anything that can read the catalog.
SELECT pg_temp.assert(
  (SELECT command LIKE '%vault.decrypted_secrets%' AND command LIKE '%service_role_key%'
     FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the cron command reads the service_role key from Vault at tick time');
SELECT pg_temp.assert(
  (SELECT command !~ '(eyJ[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{5,}|sbp_[A-Za-z0-9_-]{5,})'
     FROM cron.job WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the cron command contains NO inline credential (it must resolve the bearer from Vault, never store it)');

-- The authority: the whole command, whitespace-normalised, hashed, must be the reviewed one.
--
-- A HASH rather than the command text itself, for two reasons. It keeps this artifact from
-- containing a literal `net.http_post` + Authorization-header + Vault-read triple, which is the
-- exact signature check-legacy-service-role-consumers.mjs hunts for — a checked-in file that
-- LOOKS like it sends the service_role key, in a repo whose whole legacy-key posture depends on
-- that scan staying meaningful, is a bad trade for readability. And it makes the comparison
-- total: any drift anywhere in the command fails, including in parts no named assertion covers.
--
-- The readable form lives in the migration that installs it
-- (supabase/migrations/20261012100000_notif_10cb_digest_cron_inert.sql), and
-- src/test/notif10cbActivationPreflight.test.ts recomputes this hash from that migration on every
-- CI run — so a legitimate change to the command fails the test rather than silently making this
-- gate reject every correct job.
SELECT pg_temp.assert_eq(
  (SELECT md5(btrim(regexp_replace(command, '\s+', ' ', 'g')))::text FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  '69204549e8cb81680e492e49ef08fdd6'::text,
  'the cron command is EXACTLY the reviewed command (any drift must be re-reviewed, not armed)');

