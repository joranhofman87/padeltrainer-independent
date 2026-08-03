-- 10c-b RU3 — refuse to arm the cron unless the world is exactly as the runbook requires.
--
-- This runs BEFORE cron.alter_job(active := true) and is the last automated check between an
-- operator and a live digest send. Every assertion here is one that has a plausible failure mode
-- in a real rollout; none of them is decoration.
--
-- Takes :run_id — the uuid the CANARY invocation itself returned. Activation is bound to THAT run
-- (see section 5). Without the binding, "a canary succeeded" was satisfiable by any run from any
-- previous rollout attempt, so a canary that failed today could not stop an activation.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

-- 1. the job must EXIST and still be INACTIVE. Arming an already-armed job is not idempotent
--    reassurance — it means someone else armed it, and the runbook's sequencing assumption
--    (switch on, canary reconciled, THEN arm) no longer holds.
SELECT pg_temp.assert((SELECT job_present FROM public.notif_digest_worker_liveness()),
  'the digest cron job exists');
SELECT pg_temp.assert(NOT (SELECT job_active FROM public.notif_digest_worker_liveness()),
  'the digest cron is still INACTIVE (if not, someone armed it out of band — stop)');

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
    WHERE jobname = 'notification-digest-worker' AND username = current_user), 1,
  'exactly one notification-digest-worker job is owned by the current user');

SELECT pg_temp.assert_eq(
  (SELECT schedule::text FROM cron.job
    WHERE jobname = 'notification-digest-worker' AND username = current_user),
  '*/5 * * * *'::text,
  'the cron schedule is the reviewed one (a drifted schedule is a different rollout)');

-- The job runs in whichever database cron.job.database names, NOT necessarily the one we are
-- connected to. A job pointed at another database would tick somewhere this preflight never looked.
SELECT pg_temp.assert_eq(
  (SELECT database::text FROM cron.job
    WHERE jobname = 'notification-digest-worker' AND username = current_user),
  current_database()::text,
  'the cron job runs in THIS database (a job bound to another database ticks somewhere this preflight cannot see)');

-- The endpoint. Asserted independently of the full-text match so the failure message names the
-- actual danger, and so this survives a legitimate future re-wording of the command.
SELECT pg_temp.assert(
  (SELECT command LIKE '%https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker%'
     FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user),
  'the cron command posts to the reviewed notification-digest-worker endpoint');

-- ...and NOTHING else. A second url in the same command is how the bearer leaves: the reviewed
-- post happens, looks healthy, and a second one ships the same header elsewhere.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM (
     SELECT regexp_matches(command, 'https?://[^'' ]+', 'g') AS u
       FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user) s
   WHERE s.u[1] <> 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'the cron command names NO url other than the reviewed endpoint');

-- The bearer must be read from Vault AT TICK TIME. A command carrying an inline credential means
-- the secret is sitting in cron.job in plaintext, readable by anything that can read the catalog.
SELECT pg_temp.assert(
  (SELECT command LIKE '%vault.decrypted_secrets%' AND command LIKE '%service_role_key%'
     FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user),
  'the cron command reads the service_role key from Vault at tick time');
SELECT pg_temp.assert(
  (SELECT command !~ '(eyJ[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{5,}|sbp_[A-Za-z0-9_-]{5,})'
     FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user),
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
    WHERE jobname = 'notification-digest-worker' AND username = current_user),
  '0c693083584cffe135e52115ec56c2f0'::text,
  'the cron command is EXACTLY the reviewed command (any drift must be re-reviewed, not armed)');

-- 2. exactly ONE event may be cut over, and it must be the one this release cut over.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_cutover), 1,
  'exactly one event carries digest_cutover');
SELECT pg_temp.assert(
  (SELECT digest_cutover FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the cutover event is open_slots_player');

-- 3. the engine must ALREADY be enabled for it. Arming the cron first would schedule a worker
--    that finds nothing to do and reports healthy — a green light over an engine still off.
SELECT pg_temp.assert(
  (SELECT digest_engine_enabled FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the digest engine is enabled for open_slots_player (enable the switch BEFORE arming the cron)');

-- 4. and no OTHER event may have been enabled along the way.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types
    WHERE digest_engine_enabled AND key <> 'open_slots_player'), 0,
  'no event other than open_slots_player has the digest engine enabled');

-- ===========================================================================
-- 5. THE CANARY — this one, not "one at some point".
--
-- Everything below is scoped to :run_id, the uuid the canary invocation returned and that
-- `canary` verified moments ago. The previous version asked only whether SOME dispatch run had
-- ever succeeded and whether SOME accepted attempt and SOME sent group existed anywhere in the
-- table. After any earlier rollout attempt all three are permanently true, so a canary that
-- errored — or that was never run — could not stop an activation.
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM public.notification_worker_runs
    WHERE run_id = :'run_id'::uuid AND phase = 'dispatch' AND channel = 'email'),
  'the run id names exactly one dispatch/email run');
SELECT pg_temp.assert(
  (SELECT status = 'succeeded' FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run SUCCEEDED');
SELECT pg_temp.assert(
  (SELECT ended_at IS NOT NULL FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run has FINISHED');

-- It must be the LATEST dispatch/email run, and nothing may be in flight. This is what makes
-- "the canary you just verified" enforceable rather than a hope: if anything dispatched after it,
-- the evidence being presented is not the newest evidence, and that later run's outcome — failure
-- included — is the one that matters.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs r
    WHERE r.phase = 'dispatch' AND r.channel = 'email' AND r.run_id <> :'run_id'::uuid
      AND (r.ended_at IS NULL
           OR r.ended_at > (SELECT ended_at FROM public.notification_worker_runs
                             WHERE run_id = :'run_id'::uuid))), 0,
  'no dispatch/email run is in flight or newer than this canary (re-run the canary and use ITS run id)');

-- ...and it must be RECENT. A canary from a previous rollout window is stale evidence about a
-- system that has since been redeployed, reconfigured or re-keyed. Six hours is a runbook step,
-- not a project phase; if it has expired, the answer is to run another canary.
SELECT pg_temp.assert(
  (SELECT now() - ended_at <= interval '6 hours'
     FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary finished within the last 6 hours (older evidence describes a system that may have changed — run a fresh canary)');

-- ...and it DELIVERED. "A dispatch run succeeded" is satisfied by an empty run that found nothing
-- to do, which proves the worker starts and finishes — not that the provider path works. Arming
-- on that would make the first real send the whole population's.
SELECT pg_temp.assert(
  (SELECT count(*) >= 1 FROM public.notification_digest_attempts a
    WHERE a.worker_run_id = :'run_id'::uuid
      AND a.recorded_at IS NOT NULL AND a.outcome_class = 'accepted'),
  'the canary recorded at least one ACCEPTED send attempt (a successful but empty run is not a canary)');
SELECT pg_temp.assert(
  (SELECT count(*) >= 1 FROM public.notification_digest_groups g
    WHERE g.state = 'sent'
      AND EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                   WHERE a.digest_group_id = g.id AND a.worker_run_id = :'run_id'::uuid)),
  'at least one digest group THIS canary attempted reached sent');

-- ===========================================================================
-- 5b. AN "ACCEPTED" ATTEMPT IS NOT PROOF OF A CLEAN SEND.
--
-- record_notification_digest_result writes outcome_class = 'accepted' and recorded_at (statement
-- at 20261004100000:1038) BEFORE it tests whether the group is already bound to a DIFFERENT
-- provider message (:1091). On a correlation mismatch it trips the breaker with reason
-- 'correlation_mismatch' and retry_at NULL — a MANUAL HOLD — and returns 'correlation_mismatch',
-- but the attempt row it already wrote still reads `accepted`, and the worker does not inspect
-- that return value (digest-worker-core.ts:335/338), so the run still finishes `succeeded`.
--
-- So the canary can be green at every level the previous assertions looked at while the pipeline
-- has permanently correlated the wrong message. Both detectors below are checked, because they
-- are independent: one is the structural invariant, one is the ledger the mismatch branch wrote.

-- Structural: on the clean path the accepting attempt's provider_message_id becomes the group's
-- (:1096-1098), so accepted-but-different IS the mismatch, with no marker to trust.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_attempts a
     JOIN public.notification_digest_groups g ON g.id = a.digest_group_id
    WHERE a.worker_run_id = :'run_id'::uuid
      AND a.outcome_class = 'accepted'
      AND a.provider_message_id IS DISTINCT FROM g.provider_message_id), 0,
  'no accepted attempt in this canary disagrees with its group about the provider message id (correlation mismatch)');

-- Ledger: the mismatch branch appends a global_config event for the run. A genuine global_config
-- outcome (401/403, quota exhausted) lands here too and is just as disqualifying, so the broader
-- reading is the safe one.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_group_attempts
    WHERE worker_run_id = :'run_id'::uuid AND action = 'global_config'), 0,
  'the canary recorded no global_config event (correlation mismatch, auth failure or quota exhaustion)');

-- 5c. and the email breaker must be CLOSED. A manual hold is state='open' with retry_at NULL, and
-- it is exactly what a correlation mismatch or an exhausted monthly quota leaves behind. Arming a
-- scheduler on top of a held-open circuit buries the hold under five-minute ticks.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_provider_circuit
    WHERE channel = 'email' AND state <> 'closed'), 0,
  'the email provider circuit is CLOSED (open/half_open means a breaker tripped and has not cleared — resolve it before arming)');

-- 6. nothing may be left in an uncertain state. A group awaiting evidence or mid-send is exactly
--    what a scheduler would multiply.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_groups
    WHERE state IN ('sending', 'awaiting_evidence', 'delivery_unknown')), 0,
  'no digest group is mid-send or awaiting evidence');

-- 7. no orphan provider event may be parked awaiting an operator. Quarantine means the
--    correlation is broken and a human has to decide; arming on top of that buries it.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_orphan_reconcile_state WHERE quarantined), 0,
  'no orphan provider event is quarantined');
