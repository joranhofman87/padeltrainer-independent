-- Rebook reminder tracking: record when (and how often) a priority-claim invitee was
-- last sent a reminder, so the academy can see "last reminded …" and avoid double-nudging.
-- Additive + backward-compatible: both columns are nullable / defaulted, and every read path
-- treats them as optional, so the frontend degrades gracefully before this is applied.
ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.slot_priority_claims.reminded_at IS
  'When the academy last sent this invitee a rebook reminder (send-rebook-reminder). NULL = never reminded.';
COMMENT ON COLUMN public.slot_priority_claims.reminder_count IS
  'How many rebook reminders the academy has sent this invitee. Incremented by send-rebook-reminder.';

-- Atomic stamp+bump for the reminders the send-rebook-reminder edge fn actually delivered.
-- Scoped to the cycle's slots (passed by the already-authorized edge fn) and to the
-- player/guest ids that received the email; only nudges still-open claims (pending/claimed),
-- mirroring the function's recipient query. Called with the service role only.
CREATE OR REPLACE FUNCTION public.bump_rebook_reminders(
  p_slot_ids uuid[],
  p_player_ids uuid[],
  p_guest_ids uuid[]
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.slot_priority_claims
     SET reminded_at = now(),
         reminder_count = reminder_count + 1
   WHERE slot_id = ANY(p_slot_ids)
     AND status IN ('pending', 'claimed')
     AND (
       (player_id IS NOT NULL AND player_id = ANY(COALESCE(p_player_ids, '{}'::uuid[])))
       OR (guest_player_id IS NOT NULL AND guest_player_id = ANY(COALESCE(p_guest_ids, '{}'::uuid[])))
     );
$$;

REVOKE ALL ON FUNCTION public.bump_rebook_reminders(uuid[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_rebook_reminders(uuid[], uuid[], uuid[]) TO service_role;
