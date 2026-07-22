-- ============================================================================
-- REBOOK · FAM-02 guest-first identity for the shared reminder SQL (PR 10d)
-- ============================================================================
-- Both rebook reminder senders (manual send-rebook-reminder + cron auto-rebook-reminder) share
-- these two service-role functions. Under FAM-02 Level 1 a claim row carrying BOTH player_id and
-- guest_player_id belongs to the GUEST person (the player_id is legacy link decoration), so who a
-- claim identifies / groups to / is stamped for must be decided GUEST-FIRST. These functions were
-- player-first, which (a) collapsed a dual-key child and their linked parent into one row, and
-- (b) over-stamped reminded_at across a shared player_id. This migration makes both guest-first.
--
-- It ALSO closes a pre-existing security leak: rebook_claims_needing_auto_reminder is SECURITY
-- DEFINER and returns recipient_email + claim_token across ALL academies, but its original
-- migration only did `REVOKE ... FROM PUBLIC` — which does NOT undo the project's
-- `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE TO anon, authenticated`. So anon/authenticated could
-- execute it and harvest invitee emails + claim tokens cross-academy. Locked down explicitly here.
-- ============================================================================

-- (1) bump_rebook_reminders — stamp reminded_at for the emailed people. GUEST-FIRST guard: the
--     player arm must require guest_player_id IS NULL, or stamping a pure-profile parent
--     (player_id in p_player_ids) also stamps every dual-key child sharing that player_id.
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
       -- profile person: match player_id ONLY on rows that are not a guest's (guest_player_id NULL)
       (player_id IS NOT NULL AND guest_player_id IS NULL AND player_id = ANY(COALESCE(p_player_ids, '{}'::uuid[])))
       -- guest person (incl. dual-key child): match the guest id
       OR (guest_player_id IS NOT NULL AND guest_player_id = ANY(COALESCE(p_guest_ids, '{}'::uuid[])))
     );
$$;

REVOKE ALL ON FUNCTION public.bump_rebook_reminders(uuid[], uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_rebook_reminders(uuid[], uuid[], uuid[]) TO service_role;

-- (2) rebook_claims_needing_auto_reminder — one representative (cycle, PERSON) row per
--     non-responder. Re-emits the latest body (20260806100000: app_now() test clock + per-cycle
--     settings.rebook_reminder_lead_hours override, clamp 1h..336h) — same FLAT SELECT structure,
--     VERBATIM window bounds — and only changes identity to GUEST-FIRST: the DISTINCT ON key,
--     recipient_name and recipient_email resolve to the guest person on a dual-key row
--     (person-identity twin + effectiveGuestEmail parity). Same RETURNS signature → no types-drift.
--     Kept flat (no CTE) to match the proven structure; the guest-first email is repeated in the
--     has-email filter exactly as the original repeated its COALESCE email.
CREATE OR REPLACE FUNCTION public.rebook_claims_needing_auto_reminder(_lead_hours int DEFAULT 24)
RETURNS TABLE (
  cycle_id uuid,
  cycle_name text,
  academy_name text,
  player_id uuid,
  guest_player_id uuid,
  recipient_name text,
  recipient_email text,
  claim_token text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- GUEST-FIRST namespaced person key (FAM-02): guest wins on a dual-key row, so a child and their
  -- linked parent stay DISTINCT representatives (the old player-first key collapsed them).
  SELECT DISTINCT ON (c.id, COALESCE('g:' || spc.guest_player_id::text, 'p:' || spc.player_id::text))
    c.id AS cycle_id,
    c.name AS cycle_name,
    ap.name AS academy_name,
    spc.player_id,
    spc.guest_player_id,
    -- GUEST-FIRST name: a dual-key child shows their OWN name; the linked profile name is only the
    -- blank-name fallback for a guest. A pure profile shows the profile name.
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN COALESCE(NULLIF(btrim(gp.full_name), ''), pr.full_name)
         ELSE pr.full_name END AS recipient_name,
    -- GUEST-FIRST email (parity with effectiveGuestEmail + personContactEmail): the guest's own
    -- address, then the linked profile, then the profile joined via player_id; a pure profile uses
    -- its own email.
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN COALESCE(NULLIF(btrim(gp.email), ''), NULLIF(btrim(lp.email), ''), NULLIF(btrim(pr.email), ''))
         ELSE NULLIF(btrim(pr.email), '') END AS recipient_email,
    spc.claim_token
  FROM public.slot_priority_claims spc
  JOIN public.availability_slots s ON s.id = spc.slot_id
  JOIN public.cycles c ON c.id = s.cyclus_id
  JOIN public.academy_profiles ap ON ap.id = c.owner_id
  LEFT JOIN public.profiles pr ON pr.id = spc.player_id
  LEFT JOIN public.guest_players gp ON gp.id = spc.guest_player_id
  LEFT JOIN public.profiles lp ON lp.id = gp.linked_profile_id  -- guest's linked-profile email fallback
  WHERE c.owner_type = 'academy'
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL          -- a rebook round
    AND COALESCE((c.settings->>'rebook_auto_reminder')::boolean, true) = true  -- opt-out, default on
    AND spc.status = 'pending'                                    -- not booked (not 'claimed')
    AND spc.response_intent IS DISTINCT FROM 'decline'            -- did not say no
    AND spc.reminded_at IS NULL                                   -- not reminded yet (manual or auto)
    AND s.priority_window_ends_at IS NOT NULL
    AND s.priority_window_ends_at > public.app_now()              -- window not closed yet (test clock)
    AND s.priority_window_ends_at <= public.app_now() + make_interval(hours => GREATEST(1, LEAST(336, COALESCE(
      -- per-round override (digits-only parse; junk falls back, never errors the cron)
      CASE WHEN c.settings->>'rebook_reminder_lead_hours' ~ '^[0-9]{1,4}$'
           THEN (c.settings->>'rebook_reminder_lead_hours')::int END,
      _lead_hours, 24))))
    -- has a deliverable (guest-first) address — same expression as recipient_email above
    AND (CASE WHEN spc.guest_player_id IS NOT NULL
              THEN COALESCE(NULLIF(btrim(gp.email), ''), NULLIF(btrim(lp.email), ''), NULLIF(btrim(pr.email), ''))
              ELSE NULLIF(btrim(pr.email), '') END) IS NOT NULL
  ORDER BY c.id,
           COALESCE('g:' || spc.guest_player_id::text, 'p:' || spc.player_id::text),
           s.priority_window_ends_at ASC;                         -- earliest-closing slot as representative
$$;

-- Correctly locked down: service-role only. The bare `REVOKE FROM PUBLIC` in the original
-- migration (20260721100000) did NOT undo the default-privileges grant to anon/authenticated,
-- leaving this SECURITY DEFINER email/token reader anon-executable cross-academy.
REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;
