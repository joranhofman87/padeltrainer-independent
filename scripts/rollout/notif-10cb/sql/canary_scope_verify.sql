-- 10c-b RU2 — WHAT THE CANARY ACTUALLY REACHED. Read-only. Takes :run_id and :max_recipients.
--
-- WHY A SECOND CHECK EXISTS AT ALL. canary_invoke.sql bounds the blast radius BEFORE it queues the
-- request, and that bound is a snapshot: it counts the live digest work visible inside its
-- transaction. pg_net dispatches after that transaction commits, and the worker materializes
-- whatever is pending at the moment it runs — so a row committed in between is sent by the same
-- invocation and was never counted. The pre-check therefore bounds what was VISIBLE at invocation
-- time, and nothing more. Saying otherwise — as the first version of that artifact did, calling it
-- simply "a safe over-estimate" — would be a claim the code does not make.
--
-- This is the half that CAN be true after the fact: once the worker has answered, its dispatch run
-- is finished and the groups it touched are durable rows. Counting distinct recipients across them
-- is the honest measure of "was that a canary". It cannot stop a send that already happened; what it
-- does is stop the operator from carrying on to `canary`, `preflight` and `activate` as though a
-- one-recipient canary had occurred when it had not.
--
-- RECIPIENTS, NOT GROUPS OR ATTEMPTS. A group is one recipient's digest for one boundary, so
-- recipient_key is what "one recipient" means; splits produce several chunk groups for the SAME
-- recipient_key and must not be counted twice. Both routes into a group are counted: `worker_run_id`
-- (stamped at lease, so it covers a group this run touched but never attempted) and an attempt row
-- (which survives even if a later run re-leases the group and overwrites worker_run_id).
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any include and before any statement.
--
-- Every unqualified function, operator, aggregate, cast and relation in this file — and in the
-- shared includes it pulls in — is resolved through search_path, which is settable per role and per
-- database and which the client-side PG* stripping cannot reach. Ordering the path is NOT a defence:
-- function resolution prefers an exact-arity, exact-type candidate over pg_catalog's VARIADIC "any"
-- wherever that schema sits, even after an explicit pg_catalog. A hostile `count(text)` reports zero;
-- a hostile `md5(text)` matches any command; a hostile `=` ignores a queued canary. Only EXCLUDING
-- such a schema works, so every artifact in this directory pins the path and
-- src/test/notif10cbActivationPreflight.test.ts fails if one stops.
--
-- SESSION-WIDE, not SET LOCAL: a transaction-scoped setting is reverted by COMMIT, and these files
-- keep asserting and reporting afterwards. pg_temp is deliberately absent — it is never searched for
-- functions or operators, and every temp object here is written as pg_temp.x.
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

-- The run must exist and be FINISHED, or "what it reached" is not yet a settled fact.
SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM public.notification_worker_runs
    WHERE run_id = :'run_id'::uuid AND phase = 'dispatch' AND channel = 'email'
      AND ended_at IS NOT NULL),
  'the run id names exactly one FINISHED dispatch/email run (an unfinished run has not reached its final scope yet)');

CREATE TEMP TABLE _canary_scope AS
  SELECT count(DISTINCT g.recipient_key)::int AS recipients,
         count(*)::int                        AS groups
    FROM public.notification_digest_groups g
   WHERE g.worker_run_id = :'run_id'::uuid
      OR EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                  WHERE a.digest_group_id = g.id AND a.worker_run_id = :'run_id'::uuid);

SELECT pg_temp.assert(
  (SELECT recipients <= :'max_recipients'::int FROM pg_temp._canary_scope),
  (SELECT format(
     'the canary reached %s recipient(s) across %s group(s), within the ceiling of %s. IT HAS ALREADY SENT — do not proceed to canary/activate; roll back (engine off, cron inactive, DIGEST_SEND_ENABLED=false) and work out where the extra work came from',
     recipients, groups, :'max_recipients'::int)
   FROM pg_temp._canary_scope));

DROP TABLE pg_temp._canary_scope;
