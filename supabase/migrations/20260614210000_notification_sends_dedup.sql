-- BJ-08: idempotency table for follower notifications (notify-followers).
--
-- notify-followers had no dedup: at ~300+ followers the serial send loop blows
-- the edge wall-clock and partially notifies, and a re-trigger (the user clicks
-- again after an apparent timeout) re-spams everyone already emailed. The only
-- email idempotency in the repo (onboarding_email_queue) does NOT cover the
-- new_availability / slot_reopened notifications this function sends.
--
-- This table records, per (trainer, player, notification event), that the email
-- was sent. The edge fn claims a dedup_key (INSERT ... ON CONFLICT DO NOTHING)
-- BEFORE sending and skips any already-claimed key; on send failure it releases
-- the claim so the notification can be retried.
--
-- service_role only: written exclusively by the edge fn (service key). RLS on +
-- no anon/authenticated policy, and EXECUTE/table privileges revoked from
-- anon/authenticated explicitly (a plain REVOKE FROM PUBLIC does not remove
-- Supabase's default anon/authenticated grants — see 20260614200000).

CREATE TABLE IF NOT EXISTS public.notification_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- the dedup primitive: a claimed key cannot be inserted twice
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_sends_dedup_key
  ON public.notification_sends (dedup_key);

-- supports a future retention sweep (delete rows older than N days)
CREATE INDEX IF NOT EXISTS idx_notification_sends_created_at
  ON public.notification_sends (created_at);

ALTER TABLE public.notification_sends ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated → RLS denies them. service_role bypasses RLS.

REVOKE ALL ON TABLE public.notification_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.notification_sends TO service_role;

COMMENT ON TABLE public.notification_sends IS
  'BJ-08 follower-notification idempotency. dedup_key = <trainer_id>:<player_id>:<event anchor> (na:<date_range> for new availability, sr:<booking_id> for a reopened slot). Claimed before send, released on failure. service_role only.';
