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

-- (1b) guest_verified_account_profile — the profile a guest VERIFIABLY maps to, using the SAME
--      precedence as can_book_member_window's authorization (20260830100000): curated person_links
--      first, then the twin bridge (twin_of_profile_id), then the transitional linked_profile_id
--      (only when there is no twin). A split-frozen guest may be a DIFFERENT human → NO verified
--      account (NULL). The raw dual-key claim.player_id is NOT consulted — it is not proof of an
--      account. Delivery/CTA must key off THIS, not the claim's player_id.
CREATE OR REPLACE FUNCTION public.guest_verified_account_profile(_guest_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.is_guest_split_frozen(_guest_id) THEN NULL ELSE COALESCE(
    -- (a) curated person_links: the profile linked to the SAME person as this guest
    (SELECT plp.profile_id
       FROM public.person_links plg
       JOIN public.person_links plp ON plp.person_id = plg.person_id
      WHERE plg.guest_player_id = _guest_id AND plp.profile_id IS NOT NULL
      LIMIT 1),
    -- (b) twin bridge (outranks the transitional link)
    (SELECT gp.twin_of_profile_id FROM public.guest_players gp WHERE gp.id = _guest_id),
    -- (c) transitional link, only when there is no twin
    (SELECT gp.linked_profile_id FROM public.guest_players gp
      WHERE gp.id = _guest_id AND gp.twin_of_profile_id IS NULL)
  ) END;
$$;
REVOKE ALL ON FUNCTION public.guest_verified_account_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guest_verified_account_profile(uuid) TO service_role;

-- (1c) resolve_guest_member_contacts — BATCH contact/account resolution for member-open recipients
--      (no per-recipient queries). Per guest: own name/email, the verified account's name/email
--      (via guest_verified_account_profile), and has_account. Delivery = own email then account
--      email; needsSignup = NOT has_account (decided independently of which address is used).
CREATE OR REPLACE FUNCTION public.resolve_guest_member_contacts(_guest_ids uuid[])
RETURNS TABLE (
  guest_id uuid,
  own_name text,
  own_email text,
  account_name text,
  account_email text,
  has_account boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    gp.id AS guest_id,
    gp.full_name AS own_name,
    NULLIF(btrim(gp.email), '') AS own_email,
    ap.full_name AS account_name,
    NULLIF(btrim(ap.email), '') AS account_email,
    (acct.profile_id IS NOT NULL) AS has_account
  FROM public.guest_players gp
  LEFT JOIN LATERAL (SELECT public.guest_verified_account_profile(gp.id) AS profile_id) acct ON true
  LEFT JOIN public.profiles ap ON ap.id = acct.profile_id
  WHERE gp.id = ANY(_guest_ids);
$$;
REVOKE ALL ON FUNCTION public.resolve_guest_member_contacts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_guest_member_contacts(uuid[]) TO service_role;

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

-- Correctly locked down: service-role only. The bare `REVOKE FROM PUBLIC` in the original
-- migration (20260721100000) did NOT undo the default-privileges grant to anon/authenticated,
-- leaving this SECURITY DEFINER email/token reader anon-executable cross-academy.
REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;

-- (2c) append_rebook_member_open_notified — ATOMIC per-recipient RB03 checkpoint. A single UPDATE
--      appends only keys not already present (dedup) to settings.rebook_member_open_notified_recipients,
--      so the sender can checkpoint each recipient AS IT SENDS (no whole-settings read-modify-write
--      that loses earlier successes on a mid-loop crash, and no clobber of a concurrent academy edit).
CREATE OR REPLACE FUNCTION public.append_rebook_member_open_notified(_cycle_id uuid, _keys text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.cycles
     SET settings = jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           '{rebook_member_open_notified_recipients}',
           COALESCE(settings->'rebook_member_open_notified_recipients', '[]'::jsonb)
             || to_jsonb(ARRAY(
                  SELECT DISTINCT k FROM unnest(_keys) AS k
                   WHERE k IS NOT NULL
                     AND NOT (COALESCE(settings->'rebook_member_open_notified_recipients', '[]'::jsonb) ? k)
                ))
         )
   WHERE id = _cycle_id;
$$;
REVOKE ALL ON FUNCTION public.append_rebook_member_open_notified(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_rebook_member_open_notified(uuid, text[]) TO service_role;

-- (3) The MEMBER-OPEN cron trio (defined in 20260714110000 / 20260817100000) has the SAME
--     default-privileges footgun: they only `REVOKE ... FROM PUBLIC`, so anon/authenticated retain
--     EXECUTE (verified in prod: anon=authenticated=true). These are SECURITY DEFINER — a client
--     could claim an arbitrary cycle to SUPPRESS its member-open notifications, unclaim one to force
--     re-notification spam, or read the detection RPC's cross-academy cycle list. notify-rebook-member-open
--     joins 10d, so lock all three to service_role here (no function redefinition — grants only).
REVOKE ALL ON FUNCTION public.rebook_cycles_needing_member_open_notice()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_rebook_member_open_notice(uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unclaim_rebook_member_open_notice(uuid)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebook_cycles_needing_member_open_notice() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_rebook_member_open_notice(uuid)      TO service_role;
GRANT EXECUTE ON FUNCTION public.unclaim_rebook_member_open_notice(uuid)    TO service_role;
