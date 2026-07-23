-- PR 10d follow-up (owner-requested, 2026-07-23): harden rebook_claims_needing_auto_reminder so a
-- PAST session can NEVER qualify for an auto-reminder.
--
-- Today eligibility keys off the priority window only (s.priority_window_ends_at > app_now() AND within
-- the lead interval). If a slot's session has ALREADY happened but its priority deadline is MALFORMED
-- and still sits in the future (a data anomaly), the function would emit a "rebook" reminder for a
-- session in the past. Add a defensive `s.start_time > public.app_now()` guard so the session itself
-- must be in the future, independent of any bad priority_window_ends_at value.
--
-- This is a PURE NARROWING of the result set: the guard only ADDS a conjunct. Everything else is
-- byte-identical to 20260927100000 — guest-first identity/name/email (FAM-02), the DISTINCT ON key,
-- the pending/decline/reminded filters, the per-round opt-out, the per-round lead-time parse, the
-- deliverable-address filter, and the ACL lockdown (service_role only). Uses public.app_now() (the
-- test clock) for parity with the existing window predicates.
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
    -- GUEST-FIRST name: a dual-key child shows their OWN name; the VERIFIED ACCOUNT's name is the
    -- blank-name fallback for a guest. A pure profile shows the profile name.
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN COALESCE(NULLIF(btrim(gp.full_name), ''), gacct.full_name)
         ELSE pr.full_name END AS recipient_name,
    -- GUEST-FIRST email, matching booking-authorization account resolution: the guest's OWN address,
    -- then the VERIFIED ACCOUNT profile's email (person_links → twin → linked, split-freeze). The raw
    -- dual-key player_id (pr) is NOT used for a guest — it is not proof of an account. A pure profile
    -- uses its own email.
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN COALESCE(NULLIF(btrim(gp.email), ''), NULLIF(btrim(gacct.email), ''))
         ELSE NULLIF(btrim(pr.email), '') END AS recipient_email,
    spc.claim_token
  FROM public.slot_priority_claims spc
  JOIN public.availability_slots s ON s.id = spc.slot_id
  JOIN public.cycles c ON c.id = s.cyclus_id
  JOIN public.academy_profiles ap ON ap.id = c.owner_id
  LEFT JOIN public.profiles pr ON pr.id = spc.player_id
  LEFT JOIN public.guest_players gp ON gp.id = spc.guest_player_id
  -- the guest's VERIFIED account (same precedence as can_book_member_window), NOT the claim's player_id
  LEFT JOIN LATERAL (SELECT public.guest_verified_account_profile(spc.guest_player_id) AS profile_id) gv ON spc.guest_player_id IS NOT NULL
  LEFT JOIN public.profiles gacct ON gacct.id = gv.profile_id
  WHERE c.owner_type = 'academy'
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL          -- a rebook round
    AND COALESCE((c.settings->>'rebook_auto_reminder')::boolean, true) = true  -- opt-out, default on
    AND spc.status = 'pending'                                    -- not booked (not 'claimed')
    AND spc.response_intent IS DISTINCT FROM 'decline'            -- did not say no
    AND spc.reminded_at IS NULL                                   -- not reminded yet (manual or auto)
    AND s.start_time > public.app_now()                          -- the SESSION must be in the future (test clock)
    AND s.priority_window_ends_at IS NOT NULL
    AND s.priority_window_ends_at > public.app_now()              -- window not closed yet (test clock)
    AND s.priority_window_ends_at <= public.app_now() + make_interval(hours => GREATEST(1, LEAST(336, COALESCE(
      -- per-round override (digits-only parse; junk falls back, never errors the cron)
      CASE WHEN c.settings->>'rebook_reminder_lead_hours' ~ '^[0-9]{1,4}$'
           THEN (c.settings->>'rebook_reminder_lead_hours')::int END,
      _lead_hours, 24))))
    -- has a deliverable (guest-first) address — same expression as recipient_email above
    AND (CASE WHEN spc.guest_player_id IS NOT NULL
              THEN COALESCE(NULLIF(btrim(gp.email), ''), NULLIF(btrim(gacct.email), ''))
              ELSE NULLIF(btrim(pr.email), '') END) IS NOT NULL
  ORDER BY c.id,
           COALESCE('g:' || spc.guest_player_id::text, 'p:' || spc.player_id::text),
           s.priority_window_ends_at ASC;                         -- earliest-closing slot as representative
$$;

-- Grants are preserved by CREATE OR REPLACE, but re-affirm the service-role lockdown explicitly
-- (this SECURITY DEFINER function returns emails + claim tokens cross-academy; never anon/authenticated).
REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;
