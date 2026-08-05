\i _job_identity_assertions.sql

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
-- 4b. NO INVOCATION MAY BE ON ITS WAY. Every canary check below reads notification_worker_runs, and
-- a run row only appears once the worker STARTS. Between `canary-invoke`'s COMMIT and that moment
-- there is nothing in that table to see — so "this canary is the newest run, nothing started after
-- it" reads clean over a freshly queued canary, and the cron gets armed on the previous canary's
-- evidence while an unverified one is still in flight.
--
-- SAID PRECISELY: this narrows that window, it does not close it. pg_net owns the queue row and
-- removes it on its own schedule, so a request already dispatched but whose worker has not yet
-- recorded a run remains invisible. The complete fix is a durable pending-invocation record, and it
-- is deferred to the Admin Notification Operations release unit (docs/FOUNDATION_ROADMAP.md), which
-- must ship before any canary regardless.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM net.http_request_queue
    WHERE url = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker'), 0,
  'no request to the digest worker is queued (a canary invocation is on its way and has not been verified — wait for it)');

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
--
-- NEWER IS MEASURED BY started_at, NOT ended_at. Ordering by completion has a hole: if the canary
-- starts, a second run starts after it and fails FAST, and the canary then finishes last, the
-- canary is the most recently ENDED run and the failure that happened after it is invisible. Both
-- are checked, plus anything still in flight (which a started_at comparison alone would miss if it
-- began before the canary). All three are schema-owned columns, not worker-reported.
--
-- A run already marked `abandoned` is NOT treated as in flight. A worker killed mid-run leaves
-- ended_at NULL forever, and without this exclusion one such run from any time in the past would
-- block every future activation with no way forward except editing the ledger by hand. Marking it
-- abandoned is the reviewed recovery step, and it is a deliberate operator act. A run that started
-- AFTER the canary still blocks even when abandoned — the started_at arm above catches it — so this
-- exclusion cannot be used to hide newer activity.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs r
    WHERE r.phase = 'dispatch' AND r.channel = 'email' AND r.run_id <> :'run_id'::uuid
      AND ((r.ended_at IS NULL AND r.status IS DISTINCT FROM 'abandoned')
           OR r.started_at > (SELECT started_at FROM public.notification_worker_runs
                               WHERE run_id = :'run_id'::uuid)
           OR r.ended_at > (SELECT ended_at FROM public.notification_worker_runs
                             WHERE run_id = :'run_id'::uuid))), 0,
  'no dispatch/email run is in flight, started after, or ended after this canary (re-run the canary and use ITS run id)');

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
-- but the attempt row it already wrote still reads `accepted`.
--
-- The worker now READS that return value and fails the run (digest-worker-core.ts), so a mismatch
-- during the canary shows up as a failed run before this gate is reached. These assertions stay as
-- DEFENCE IN DEPTH and are not redundant: a mismatch that arrives by WEBHOOK after the run has
-- finished is reported by no return value at all, and they keep holding if a later worker change
-- loses the check. Both detectors below are checked because they are independent: one is the
-- structural invariant, one is the ledger the mismatch branch wrote.

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
-- EXACTLY ONE closed row, not "no non-closed rows". Counting only the bad states passes
-- VACUOUSLY when the row is absent — and absence is not a neutral state here:
-- begin_notification_digest_attempt ENSURES the row exists before it sends
-- (20261004100000, the INSERT ... ON CONFLICT DO NOTHING before the breaker gate), so a canary that
-- really sent guarantees one. Missing afterwards means the breaker state was lost or wiped, which
-- is exactly when a gate must fail closed rather than read silence as health.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_provider_circuit
    WHERE channel = 'email' AND state = 'closed'), 1,
  'the email provider circuit exists and is CLOSED (open/half_open means a breaker tripped and has not cleared — resolve it before arming)');

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

-- 7b. ...and NO orphan at all may be outstanding against a group THIS canary attempted, quarantined
-- or not. A tag/message mismatch arriving by webhook takes the uncorrelated branch of
-- apply_notification_provider_event (20261006110000): it enrols an orphan row with
-- `quarantined = false` and leaves the group `sent`, the circuit closed and the run ledger
-- untouched. Every other assertion above therefore passes over it, and the FIRST armed tick is what
-- discovers it — quarantines it, and fails. The canary exists precisely so that discovery does not
-- happen under a scheduler. Scoped to this canary's groups so an unrelated backlog elsewhere, which
-- the worker drains on its own, does not block activation.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_orphan_reconcile_state o
    WHERE EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                   WHERE a.digest_group_id = o.digest_group_id
                     AND a.worker_run_id = :'run_id'::uuid)), 0,
  'no provider event is still unreconciled against a group this canary sent (a tag/message mismatch enrols an orphan that is NOT quarantined and leaves the group looking sent)');

-- 8. THE CANARY'S PROVENANCE, asserted INDEPENDENTLY here (N4 AC-6). canary_reconcile refuses a
-- non-canary invocation, but activation is the authoritative gate and must not depend on the
-- operator having run reconciliation correctly. Without this, a SMOKE whose switch assertion was
-- wrong could actually send, its dispatch run be handed to `activate`, and every run-level
-- assertion above pass over evidence the reviewed canary never produced. The run must be bound
-- to exactly ONE invocation, COMPLETED, opened by the canary artifact, with its dispatched
-- pg_net request recorded.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_invocations
    WHERE worker_run_id = :'run_id'::uuid
      AND status = 'completed'
      AND purpose = 'canary'
      AND source = 'canary_invoke.sql'
      AND net_request_id IS NOT NULL), 1,
  'the run is bound to exactly one COMPLETED canary-provenance invocation (purpose=canary, source=canary_invoke.sql, recorded pg_net request) — an accidental smoke cannot activate, and an unreconciled canary must pass canary-reconcile first');


-- 9. NO CHANNEL IS KILLED (N4 seam correction). Arming behind an active kill looks safe — the
-- gated claim parks every tick — but it moves the send decision to whoever later deletes the
-- kill row: a runbook DELETE would release an ALREADY-ARMED cron with no fresh canary and no
-- activation decision. M5 refuses a circuit reset under a kill for exactly this reason
-- ("queue send authority behind a single runbook DELETE"); arming is the larger version of the
-- same act. The shared per-channel lock is taken so an in-flight kill cannot be missed.
DO $kill$
DECLARE ch text;
BEGIN
  -- take the shared per-channel lock FIRST (an in-flight kill must not be invisible), then read
  FOREACH ch IN ARRAY ARRAY['email', 'whatsapp'] LOOP
    PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('notif-channel-kill:' || ch, 0));
  END LOOP;
END
$kill$;
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_channel_kill_switches), 0,
  'no notification channel is killed (arming while a kill is active hands the send decision to whoever deletes the kill row, with no canary and no activation gate)');
