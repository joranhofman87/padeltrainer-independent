-- 10c-b A — close CRON-SF-WEDGE: retire the session-scoped cron advisory lock.
--
-- THE DEFECT (CRON-SF-WEDGE). 20260614190000 shipped try_lock_cron_job /
-- unlock_cron_job as SESSION-scoped `pg_try_advisory_lock(hashtextextended(job,0))`.
-- An edge function issues many separate PostgREST round-trips per run and Supabase
-- pools connections with NO session affinity, so the unlock routinely lands on a
-- DIFFERENT backend than the lock. The lock then survives the run and every later
-- tick sees try_lock = false until that pooled connection happens to be recycled —
-- an unbounded wedge of a scheduled job, with no operator-visible signal. It is
-- also unreleasable by design: only the backend that took it can drop it.
--
-- THE FIX is per worker, and is deliberately NOT "another lock":
--
--   * notification-email-worker, notification-whatsapp-worker  → lock REMOVED.
--     Both claim work through claim_notification_outbox_batch, an atomic
--     `FOR UPDATE SKIP LOCKED` claim that stamps a per-run lock token on every row
--     it takes. Two concurrent invocations therefore claim DISJOINT row sets and
--     cannot duplicate a send; record_notification_send_result is token-guarded so a
--     late write from a superseded run no-ops. The advisory lock added nothing the
--     claim did not already guarantee — the email worker's own comment said so.
--
--   * process-onboarding-emails → lock REMOVED. Every queue item passes through
--     claim_onboarding_email_queue_item, a per-row atomic CAS; an item already
--     claimed by a concurrent run is skipped, never re-sent.
--
--   * invoice-health-check → DURABLE LEASE (this migration). It has NO atomic
--     claim to lean on: it is a read-only sweep that ends in operator Slack alerts
--     and a reconcile_payments report. Whole-RUN exclusion is genuinely required —
--     two overlapping runs duplicate every operator alert. So it gets an owner-token
--     + locked_until lease that lives in a TABLE, not in a backend's session state.
--
-- Why the lease cannot wedge, and cannot be stolen:
--   * expiry is DATA (`locked_until`), so a crashed holder frees the job at TTL with
--     no connection recycling, no manual intervention, and no operator action.
--   * acquisition is a single atomic INSERT … ON CONFLICT DO UPDATE … WHERE the row
--     is expired; the WHERE runs under the row lock ON CONFLICT already holds, so two
--     racing acquirers cannot both win — the loser's UPDATE matches zero rows.
--   * release and renew are owner-token CAS: a run that lost its lease to expiry, or
--     any other caller, cannot release or extend somebody else's lease.
--   * every RPC is a separate self-contained statement, so it is safe across pooled
--     connections: nothing depends on which backend serves which call.
--
-- Forward-only. The two advisory-lock RPCs are DROPPED here so the wedge class
-- cannot be reintroduced by a future caller; nothing in the tree calls them after
-- this migration (the digest worker never did — see _shared/digest-worker-handler.ts).

-- 1. the lease table. One row per job name, created on first acquisition.
CREATE TABLE IF NOT EXISTS public.cron_job_leases (
  job_name      text        PRIMARY KEY,
  owner_token   uuid        NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz NOT NULL,
  renewed_at    timestamptz,
  release_count bigint      NOT NULL DEFAULT 0,
  CONSTRAINT chk_cron_lease_window CHECK (locked_until > acquired_at)
);

COMMENT ON TABLE public.cron_job_leases IS
  'Durable single-flight leases for scheduled edge functions. Replaces the session-scoped try_lock_cron_job advisory lock (CRON-SF-WEDGE): expiry is data, so a crashed holder cannot wedge the job past locked_until, and release is owner-token guarded.';

ALTER TABLE public.cron_job_leases ENABLE ROW LEVEL SECURITY;
-- No policy: the table is reachable ONLY through the SECURITY DEFINER RPCs below.
REVOKE ALL ON TABLE public.cron_job_leases FROM PUBLIC, anon, authenticated, service_role;
-- service_role may READ lease state for operational visibility, never mutate it directly.
GRANT SELECT ON TABLE public.cron_job_leases TO service_role;

-- 2. acquire. Returns a fresh owner token, or NULL when a live lease is held.
--    A caller that gets NULL must bail — it is NOT the single-flight owner.
CREATE OR REPLACE FUNCTION public.acquire_cron_lease(
  p_job_name    text,
  p_ttl_seconds int DEFAULT 900
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_now   timestamptz := now();
  v_got   uuid;
BEGIN
  IF p_job_name IS NULL OR btrim(p_job_name) = '' THEN
    RAISE EXCEPTION 'acquire_cron_lease: job name is required';
  END IF;
  -- Bounded TTL: 0/negative would hand out an already-expired lease (every caller
  -- "wins" → no single-flight at all); an unbounded TTL would recreate the wedge.
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 30 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'acquire_cron_lease: ttl_seconds must be between 30 and 3600 (got %)', p_ttl_seconds;
  END IF;

  -- Atomic take-or-refuse. ON CONFLICT holds the row lock while the WHERE is
  -- evaluated, so exactly one of two racing acquirers can satisfy `locked_until <=
  -- now()`; the other updates zero rows and RETURNING yields no row → NULL.
  INSERT INTO public.cron_job_leases AS l (job_name, owner_token, acquired_at, locked_until)
  VALUES (btrim(p_job_name), v_token, v_now, v_now + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (job_name) DO UPDATE
     SET owner_token  = EXCLUDED.owner_token,
         acquired_at  = EXCLUDED.acquired_at,
         locked_until = EXCLUDED.locked_until,
         renewed_at   = NULL
   WHERE l.locked_until <= v_now
  RETURNING l.owner_token INTO v_got;

  RETURN v_got;   -- NULL = a live lease is held by someone else
END $$;

-- 3. renew. Owner-token CAS: only the live owner can extend, and only while its
--    lease has not already expired (an expired lease may belong to someone else).
CREATE OR REPLACE FUNCTION public.renew_cron_lease(
  p_job_name    text,
  p_owner_token uuid,
  p_ttl_seconds int DEFAULT 900
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_now timestamptz := now(); v_hit int;
BEGIN
  IF p_owner_token IS NULL THEN RETURN false; END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 30 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'renew_cron_lease: ttl_seconds must be between 30 and 3600 (got %)', p_ttl_seconds;
  END IF;

  UPDATE public.cron_job_leases
     SET locked_until = v_now + make_interval(secs => p_ttl_seconds),
         renewed_at   = v_now
   WHERE job_name     = btrim(p_job_name)
     AND owner_token  = p_owner_token
     AND locked_until > v_now;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit = 1;
END $$;

-- 4. release. Owner-token CAS. A WRONG owner releases NOTHING and is told so.
--    Releasing is idempotent for the true owner only: the second call reports false
--    because the lease is no longer held by that token.
CREATE OR REPLACE FUNCTION public.release_cron_lease(
  p_job_name    text,
  p_owner_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_hit int;
BEGIN
  IF p_owner_token IS NULL THEN RETURN false; END IF;
  -- Free the job by expiring it in place (keeps the row for observability) rather
  -- than deleting, so release_count/acquired_at remain queryable for liveness.
  UPDATE public.cron_job_leases
     SET locked_until  = acquired_at + interval '1 microsecond',
         release_count = release_count + 1
   WHERE job_name    = btrim(p_job_name)
     AND owner_token = p_owner_token;
  GET DIAGNOSTICS v_hit = ROW_COUNT;
  RETURN v_hit = 1;
END $$;

COMMENT ON FUNCTION public.acquire_cron_lease(text,int) IS
  'Durable single-flight: returns an owner token, or NULL when a live lease is held. Expiry is data, so a crashed holder frees the job at locked_until.';
COMMENT ON FUNCTION public.renew_cron_lease(text,uuid,int) IS
  'Extend a lease you still own. False if the token is not the live owner or the lease already expired.';
COMMENT ON FUNCTION public.release_cron_lease(text,uuid) IS
  'Release a lease you own. False for a wrong/stale token — one run can never release another run''s lease.';

REVOKE ALL ON FUNCTION public.acquire_cron_lease(text,int)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_cron_lease(text,uuid,int)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_cron_lease(text,uuid)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_cron_lease(text,int)    TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_cron_lease(text,uuid,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_cron_lease(text,uuid)   TO service_role;

-- 5. retire the wedge primitives. No caller remains; dropping them is what makes
--    the fix durable — a future worker cannot reach for them by habit.
DROP FUNCTION IF EXISTS public.try_lock_cron_job(text);
DROP FUNCTION IF EXISTS public.unlock_cron_job(text);
