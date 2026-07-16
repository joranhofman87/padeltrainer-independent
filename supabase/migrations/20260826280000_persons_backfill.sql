-- ============================================================================
-- Person unification — PHASE 2: BACKFILL + MERGE (docs/PERSON_UNIFICATION_PLAN.md §5)
-- ============================================================================
-- The one-time data moment of the program, plus the LIVE map maintenance that keeps it true:
--   A. one person per profile (the account is the strongest identity);
--   B. guests AUTO-MERGE into a profile's person ONLY on the locked rules:
--        B1. an explicit twin_of_profile_id stamp passing the TRUST RULE (guest email matches the
--            profile's case-insensitively, OR guest is emailless with
--            source='roster_registered_twin');
--        B2. an exact (case-insensitive, non-empty) email match where that email maps to exactly
--            ONE profile and ONE guest system-wide — never inside a shared-email cluster;
--      `linked_profile_id` is NEVER consumed as identity truth (hard rule) — it only seeds
--      suggestions in the review report.
--   C. every remaining guest gets its OWN person (shared-email families stay separate people
--      until the owner signs off in person_merge_review — P-B);
--   D. merged persons: profile wins account fields, the guest fills non-null identity gaps;
--   E. person_merge_review — the owner sign-off report (ambiguous cases) + audit trail (what
--      auto-merged and why);
--   F. stamp the person columns on every existing row of the 7 dual-keyed tables (9 pairs), same
--      derivation the Phase-1 triggers use (guest-side first);
--   G. hard verification — any invariant violation RAISES and rolls back the whole migration;
--   H. LIVE minting — AFTER INSERT triggers on profiles/guest_players mint the person + link at
--      creation time (applying the same B1/B2 rules to new guests), and a twin-stamp UPDATE
--      collapses the guest's fresh person into the profile's when the trust rule passes and the
--      collapse is provably safe. Without H the map would decay on the first signup after deploy.
--
-- Idempotent throughout (NOT EXISTS guards): re-running the migration is a no-op.
-- All functions SECURITY DEFINER (0c round-3 doctrine: they read/write RLS-locked tables).

-- Freeze the source tables for the duration of the migration transaction: an INSERT committing
-- between section G's verification snapshot and the H trigger installation would be neither
-- backfilled nor live-minted — a permanent map hole. SHARE ROW EXCLUSIVE blocks writes (reads
-- continue); writers queue and re-run against the installed triggers after commit.
-- Wrapped in DO because `supabase db reset` (local/CI) applies statements individually — there
-- the lock is an instant no-op (fresh DB, no concurrency), while `supabase db push` (prod, the
-- run that matters) executes the whole migration in ONE transaction, so the lock taken here is
-- held until commit.
DO $$
BEGIN
  LOCK TABLE public.profiles, public.guest_players IN SHARE ROW EXCLUSIVE MODE;
END $$;

-- ---------------------------------------------------------------------------
-- E0) the review/audit table (owner sign-off happens here — P-B)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.person_merge_review (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL,   -- auto_merged_email_pair | auto_merged_twin_trust |
                                        -- shared_email_cluster | no_email_guest | multi_profile_email |
                                        -- twin_trust_failure | linked_mismatch | twin_detached_needs_split |
                                        -- signup_pair_needs_review | merged_guest_email_moved
  status               text NOT NULL DEFAULT 'pending',  -- pending | applied | dismissed
  email                text,
  guest_player_id      uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  profile_id           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  person_id            uuid REFERENCES public.persons(id) ON DELETE SET NULL,
  suggested_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_person_merge_review_status ON public.person_merge_review (status, kind);

ALTER TABLE public.person_merge_review ENABLE ROW LEVEL SECURITY;  -- no policies: owner/service only

-- ---------------------------------------------------------------------------
-- A) one person per profile
-- ---------------------------------------------------------------------------
-- Deterministic ids: a profile's person REUSES the profile's uuid (and a guest-only person its
-- guest's uuid below) — collision-free (uuid space), idempotent, and debuggable: the person id of
-- every account holder survives Phase 4 as their old profile id.
INSERT INTO public.persons (
  id, user_id, full_name, first_name, last_name, email, phone, birth_date,
  skill_rating, rating_system, rating_member_id, avatar_url, bio, location,
  preferred_language, billing_business_name, billing_address, billing_btw_number,
  stripe_customer_id
)
SELECT
  p.id, p.user_id, p.full_name, p.first_name, p.last_name, p.email, p.phone, p.birth_date,
  p.skill_rating, p.rating_system, p.rating_member_id, p.avatar_url, p.bio, p.location,
  p.preferred_language, p.billing_business_name, p.billing_address, p.billing_btw_number,
  p.stripe_customer_id
FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.profile_id = p.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.person_links (person_id, profile_id)
SELECT p.id, p.id
FROM public.profiles p
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.profile_id = p.id);

-- ---------------------------------------------------------------------------
-- B1) twin-trust merges: explicit stamp + trust rule → the guest IS that profile's person
-- ---------------------------------------------------------------------------
INSERT INTO public.person_links (person_id, guest_player_id)
SELECT plp.person_id, g.id
FROM public.guest_players g
JOIN public.profiles pr ON pr.id = g.twin_of_profile_id
JOIN public.person_links plp ON plp.profile_id = pr.id
WHERE g.twin_of_profile_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.guest_player_id = g.id)
  AND (
    (nullif(btrim(g.email), '') IS NOT NULL AND nullif(btrim(pr.email), '') IS NOT NULL
     AND lower(btrim(g.email)) = lower(btrim(pr.email)))
    OR (nullif(btrim(g.email), '') IS NULL AND g.source = 'roster_registered_twin')
  );

INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
SELECT 'auto_merged_twin_trust', 'applied', g.email, g.id, g.twin_of_profile_id, pl.person_id,
       jsonb_build_object('guest_name', g.full_name)
FROM public.guest_players g
JOIN public.person_links pl ON pl.guest_player_id = g.id
JOIN public.person_links plp ON plp.profile_id = g.twin_of_profile_id AND plp.person_id = pl.person_id
WHERE g.twin_of_profile_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'auto_merged_twin_trust');

-- ---------------------------------------------------------------------------
-- B2) unique email-pair merges: the email maps to exactly ONE profile and ONE guest system-wide
-- ---------------------------------------------------------------------------
WITH pe AS (
  SELECT id, lower(btrim(email)) AS e FROM public.profiles
  WHERE nullif(btrim(email), '') IS NOT NULL
),
ge AS (
  SELECT id, lower(btrim(email)) AS e FROM public.guest_players
  WHERE nullif(btrim(email), '') IS NOT NULL
),
uniq_pairs AS (
  SELECT g.id AS guest_id, p.id AS profile_id
  FROM ge g
  JOIN pe p ON p.e = g.e
  WHERE (SELECT count(*) FROM pe p2 WHERE p2.e = g.e) = 1
    AND (SELECT count(*) FROM ge g2 WHERE g2.e = g.e) = 1
)
INSERT INTO public.person_links (person_id, guest_player_id)
SELECT plp.person_id, up.guest_id
FROM uniq_pairs up
JOIN public.person_links plp ON plp.profile_id = up.profile_id
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.guest_player_id = up.guest_id);

INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
SELECT 'auto_merged_email_pair', 'applied', g.email, g.id, plp.profile_id, pl.person_id,
       jsonb_build_object('guest_name', g.full_name)
FROM public.guest_players g
JOIN public.person_links pl ON pl.guest_player_id = g.id
JOIN public.person_links plp ON plp.person_id = pl.person_id AND plp.profile_id IS NOT NULL
WHERE g.twin_of_profile_id IS DISTINCT FROM plp.profile_id  -- not already logged as twin-trust
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind IN ('auto_merged_email_pair', 'auto_merged_twin_trust'));

-- ---------------------------------------------------------------------------
-- C) every remaining guest gets its OWN person (families stay separate until sign-off)
-- ---------------------------------------------------------------------------
INSERT INTO public.persons (
  id, full_name, first_name, last_name, email, phone, birth_date,
  skill_rating, rating_system, billing_business_name, billing_address, billing_btw_number
)
SELECT
  g.id, g.full_name, g.first_name, g.last_name, g.email, g.phone, g.birth_date,
  g.skill_rating, g.rating_system, g.billing_business_name, g.billing_address, g.billing_btw_number
FROM public.guest_players g
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.guest_player_id = g.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.person_links (person_id, guest_player_id)
SELECT g.id, g.id
FROM public.guest_players g
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.guest_player_id = g.id);

-- ---------------------------------------------------------------------------
-- D) person attribute derivation — ONE function, used by the backfill AND every live path
--    (external re-audit P1/P2: bespoke per-path field logic would drift; this cannot).
--    Rule: the profile (if any) wins every field it has; guests fill the gaps PER FIELD,
--    oldest guest first; account-only fields come from the profile or are NULL. A person
--    with NO links (a future Phase-3 new-world person) is writer-managed — never touched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rederive_person(_person uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  p public.profiles%ROWTYPE;
  g record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.person_links pl WHERE pl.person_id = _person) THEN
    RETURN;  -- keyless new-world person: writer-managed
  END IF;

  SELECT pr.* INTO p
  FROM public.person_links pl
  JOIN public.profiles pr ON pr.id = pl.profile_id
  WHERE pl.person_id = _person AND pl.profile_id IS NOT NULL;

  SELECT
    (array_remove(array_agg(gp.full_name ORDER BY gp.created_at), NULL))[1] AS full_name,
    (array_remove(array_agg(gp.first_name ORDER BY gp.created_at), NULL))[1] AS first_name,
    (array_remove(array_agg(gp.last_name ORDER BY gp.created_at), NULL))[1] AS last_name,
    (array_remove(array_agg(gp.email ORDER BY gp.created_at), NULL))[1] AS email,
    (array_remove(array_agg(gp.phone ORDER BY gp.created_at), NULL))[1] AS phone,
    (array_remove(array_agg(gp.birth_date ORDER BY gp.created_at), NULL))[1] AS birth_date,
    (array_remove(array_agg(gp.skill_rating ORDER BY gp.created_at), NULL))[1] AS skill_rating,
    (array_remove(array_agg(gp.rating_system ORDER BY gp.created_at), NULL))[1] AS rating_system,
    (array_remove(array_agg(gp.billing_business_name ORDER BY gp.created_at), NULL))[1] AS billing_business_name,
    (array_remove(array_agg(gp.billing_address ORDER BY gp.created_at), NULL))[1] AS billing_address,
    (array_remove(array_agg(gp.billing_btw_number ORDER BY gp.created_at), NULL))[1] AS billing_btw_number
  INTO g
  FROM public.person_links pl
  JOIN public.guest_players gp ON gp.id = pl.guest_player_id
  WHERE pl.person_id = _person AND pl.guest_player_id IS NOT NULL;

  UPDATE public.persons pe SET
    user_id               = p.user_id,
    full_name             = COALESCE(p.full_name, g.full_name),
    first_name            = COALESCE(p.first_name, g.first_name),
    last_name             = COALESCE(p.last_name, g.last_name),
    email                 = COALESCE(p.email, g.email),
    phone                 = COALESCE(p.phone, g.phone),
    birth_date            = COALESCE(p.birth_date, g.birth_date),
    skill_rating          = COALESCE(p.skill_rating, g.skill_rating),
    rating_system         = COALESCE(p.rating_system, g.rating_system),
    billing_business_name = COALESCE(p.billing_business_name, g.billing_business_name),
    billing_address       = COALESCE(p.billing_address, g.billing_address),
    billing_btw_number    = COALESCE(p.billing_btw_number, g.billing_btw_number),
    rating_member_id      = p.rating_member_id,
    avatar_url            = p.avatar_url,
    bio                   = p.bio,
    location              = p.location,
    preferred_language    = p.preferred_language,
    stripe_customer_id    = p.stripe_customer_id
  WHERE pe.id = _person;
END;
$$;

REVOKE ALL ON FUNCTION public.rederive_person(uuid) FROM PUBLIC, anon, authenticated;

-- backfill: derive every person through the SAME function the live paths use
DO $$
BEGIN
  PERFORM public.rederive_person(x.person_id)
  FROM (SELECT DISTINCT person_id FROM public.person_links) x;
END $$;

-- ---------------------------------------------------------------------------
-- E) the review report (pending rows = the owner's sign-off queue — P-B)
-- ---------------------------------------------------------------------------
-- E1: shared-email clusters (guest↔guest and/or ambiguous guest↔profile on one address)
WITH ge AS (
  SELECT id, full_name, email, lower(btrim(email)) AS e FROM public.guest_players
  WHERE nullif(btrim(email), '') IS NOT NULL
),
clusters AS (SELECT e, count(*) AS n FROM ge GROUP BY e HAVING count(*) > 1)
INSERT INTO public.person_merge_review (kind, email, guest_player_id, suggested_profile_id, details)
SELECT 'shared_email_cluster', g.email, g.id,
       (SELECT p.id FROM public.profiles p
        WHERE lower(btrim(p.email)) = g.e AND nullif(btrim(p.email), '') IS NOT NULL
        LIMIT 1),
       jsonb_build_object('guest_name', g.full_name, 'cluster_size', c.n)
FROM ge g
JOIN clusters c ON c.e = g.e
WHERE NOT EXISTS (SELECT 1 FROM public.person_links pl          -- already merged (e.g. a trusted
                  WHERE pl.guest_player_id = g.id               -- twin inside the cluster) → the
                    AND EXISTS (SELECT 1 FROM public.person_links pl2   -- case is resolved, keep the
                                WHERE pl2.person_id = pl.person_id      -- sign-off queue clean
                                  AND pl2.profile_id IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'shared_email_cluster');

-- E1b: a guest whose email matches MULTIPLE profiles — B2 rightly refuses (ambiguous), but the
-- ambiguity must reach the sign-off queue (profiles.email is unconstrained text; duplicates CAN
-- exist even though prod currently measures 0).
INSERT INTO public.person_merge_review (kind, email, guest_player_id, details)
SELECT 'multi_profile_email', g.email, g.id,
       jsonb_build_object('guest_name', g.full_name,
                          'profile_count', (SELECT count(*) FROM public.profiles p
                                            WHERE lower(btrim(p.email)) = lower(btrim(g.email))
                                              AND nullif(btrim(p.email), '') IS NOT NULL))
FROM public.guest_players g
WHERE nullif(btrim(g.email), '') IS NOT NULL
  AND (SELECT count(*) FROM public.profiles p
       WHERE lower(btrim(p.email)) = lower(btrim(g.email))
         AND nullif(btrim(p.email), '') IS NOT NULL) > 1
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'multi_profile_email');

-- E2: no-email guests
INSERT INTO public.person_merge_review (kind, guest_player_id, details)
SELECT 'no_email_guest', g.id, jsonb_build_object('guest_name', g.full_name, 'source', g.source)
FROM public.guest_players g
WHERE nullif(btrim(g.email), '') IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.person_links pl
                  WHERE pl.guest_player_id = g.id
                    AND EXISTS (SELECT 1 FROM public.person_links pl2
                                WHERE pl2.person_id = pl.person_id AND pl2.profile_id IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'no_email_guest');

-- E3: twin stamps that FAILED the trust rule (explicit assertion vs divergent email — investigate)
INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, details)
SELECT 'twin_trust_failure', g.email, g.id, g.twin_of_profile_id,
       jsonb_build_object('guest_name', g.full_name, 'profile_email', pr.email)
FROM public.guest_players g
JOIN public.profiles pr ON pr.id = g.twin_of_profile_id
WHERE g.twin_of_profile_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.person_links pl
                  WHERE pl.guest_player_id = g.id
                    AND pl.person_id = (SELECT person_id FROM public.person_links
                                        WHERE profile_id = g.twin_of_profile_id))
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'twin_trust_failure');

-- E4: linked_profile_id SUGGESTIONS — never consumed as truth; a link disagreeing with the final
--     person mapping is a stale mislink the owner may want to clean up.
INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, suggested_profile_id, details)
SELECT 'linked_mismatch', g.email, g.id, g.linked_profile_id, g.linked_profile_id,
       jsonb_build_object('guest_name', g.full_name, 'linked_profile_email', pr.email,
                          'note', 'guest''s person is NOT the linked profile''s person — link is inference-only')
FROM public.guest_players g
JOIN public.profiles pr ON pr.id = g.linked_profile_id
WHERE g.linked_profile_id IS NOT NULL
  AND (SELECT person_id FROM public.person_links WHERE guest_player_id = g.id)
      IS DISTINCT FROM (SELECT person_id FROM public.person_links WHERE profile_id = g.linked_profile_id)
  AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                  WHERE r.guest_player_id = g.id AND r.kind = 'linked_mismatch');

-- ---------------------------------------------------------------------------
-- F) stamp the 9 pairs on all existing keyed rows (same derivation as the Phase-1 triggers:
--    guest-side first). User triggers are disabled per table during the sweep so updated_at is
--    preserved and the stamp triggers don't redo the identical lookup; the SET below IS the
--    trigger's derivation.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings DISABLE TRIGGER USER;
UPDATE public.bookings t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.player_id)),
  paid_by_person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.paid_by_guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.paid_by_player_id))
WHERE t.player_id IS NOT NULL OR t.guest_player_id IS NOT NULL
   OR t.paid_by_player_id IS NOT NULL OR t.paid_by_guest_player_id IS NOT NULL;
ALTER TABLE public.bookings ENABLE TRIGGER USER;

ALTER TABLE public.invoices DISABLE TRIGGER USER;
UPDATE public.invoices t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.player_id))
WHERE t.player_id IS NOT NULL OR t.guest_player_id IS NOT NULL;
ALTER TABLE public.invoices ENABLE TRIGGER USER;

ALTER TABLE public.intake_requests DISABLE TRIGGER USER;
UPDATE public.intake_requests t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.player_id))
WHERE t.player_id IS NOT NULL OR t.guest_player_id IS NOT NULL;
ALTER TABLE public.intake_requests ENABLE TRIGGER USER;

ALTER TABLE public.slot_priority_claims DISABLE TRIGGER USER;
UPDATE public.slot_priority_claims t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.player_id)),
  booked_by_person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.booked_by_guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.booked_by_player_id))
WHERE t.player_id IS NOT NULL OR t.guest_player_id IS NOT NULL
   OR t.booked_by_player_id IS NOT NULL OR t.booked_by_guest_player_id IS NOT NULL;
ALTER TABLE public.slot_priority_claims ENABLE TRIGGER USER;

ALTER TABLE public.session_player_notes DISABLE TRIGGER USER;
UPDATE public.session_player_notes t SET
  subject_person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.subject_guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.subject_profile_id))
WHERE t.subject_profile_id IS NOT NULL OR t.subject_guest_player_id IS NOT NULL;
ALTER TABLE public.session_player_notes ENABLE TRIGGER USER;

ALTER TABLE public.academy_player_locations DISABLE TRIGGER USER;
UPDATE public.academy_player_locations t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.profile_id))
WHERE t.profile_id IS NOT NULL OR t.guest_player_id IS NOT NULL;
ALTER TABLE public.academy_player_locations ENABLE TRIGGER USER;

ALTER TABLE public.academy_player_metadata DISABLE TRIGGER USER;
UPDATE public.academy_player_metadata t SET
  person_id = COALESCE(
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = t.guest_player_id),
    (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = t.profile_id))
WHERE t.profile_id IS NOT NULL OR t.guest_player_id IS NOT NULL;
ALTER TABLE public.academy_player_metadata ENABLE TRIGGER USER;

-- ---------------------------------------------------------------------------
-- G) HARD verification — any violation aborts (rolls back) the whole migration
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_profiles bigint; v_profile_links bigint;
  v_guests bigint; v_guest_links bigint;
  v_unstamped bigint; v_user_mismatch bigint;
BEGIN
  SELECT count(*) INTO v_profiles FROM public.profiles;
  SELECT count(*) INTO v_profile_links FROM public.person_links WHERE profile_id IS NOT NULL;
  IF v_profiles <> v_profile_links THEN
    RAISE EXCEPTION 'persons backfill: % profiles but % profile links', v_profiles, v_profile_links;
  END IF;

  SELECT count(*) INTO v_guests FROM public.guest_players;
  SELECT count(*) INTO v_guest_links FROM public.person_links WHERE guest_player_id IS NOT NULL;
  IF v_guests <> v_guest_links THEN
    RAISE EXCEPTION 'persons backfill: % guests but % guest links', v_guests, v_guest_links;
  END IF;

  -- persons.user_id must mirror the linked profile's user_id (account integrity)
  SELECT count(*) INTO v_user_mismatch
  FROM public.person_links pl
  JOIN public.profiles p ON p.id = pl.profile_id
  JOIN public.persons pe ON pe.id = pl.person_id
  WHERE pe.user_id IS DISTINCT FROM p.user_id;
  IF v_user_mismatch > 0 THEN
    RAISE EXCEPTION 'persons backfill: % persons with user_id mismatching their profile', v_user_mismatch;
  END IF;

  -- MONEY invariant: no keyed row of any pair may be left unstamped
  SELECT
    (SELECT count(*) FROM public.bookings WHERE (player_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  + (SELECT count(*) FROM public.bookings WHERE (paid_by_player_id IS NOT NULL OR paid_by_guest_player_id IS NOT NULL) AND paid_by_person_id IS NULL)
  + (SELECT count(*) FROM public.invoices WHERE (player_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  + (SELECT count(*) FROM public.intake_requests WHERE (player_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  + (SELECT count(*) FROM public.slot_priority_claims WHERE (player_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  + (SELECT count(*) FROM public.slot_priority_claims WHERE (booked_by_player_id IS NOT NULL OR booked_by_guest_player_id IS NOT NULL) AND booked_by_person_id IS NULL)
  + (SELECT count(*) FROM public.session_player_notes WHERE (subject_profile_id IS NOT NULL OR subject_guest_player_id IS NOT NULL) AND subject_person_id IS NULL)
  + (SELECT count(*) FROM public.academy_player_locations WHERE (profile_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  + (SELECT count(*) FROM public.academy_player_metadata WHERE (profile_id IS NOT NULL OR guest_player_id IS NOT NULL) AND person_id IS NULL)
  INTO v_unstamped;
  IF v_unstamped > 0 THEN
    RAISE EXCEPTION 'persons backfill: % keyed rows left unstamped', v_unstamped;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- H) LIVE map maintenance — the map must never decay
-- ---------------------------------------------------------------------------
-- Shared safe-collapse: fold a guest's own person into a target (profile) person — used by the
-- live twin claim (H3) and the signup reverse-pair (H1). Collapses ONLY when the guest's current
-- person is sole-source and login-less; re-points the link FIRST so the Phase-1 stamp triggers
-- re-derive consistently, then re-stamps the guest's existing rows and drops the orphan person.
CREATE OR REPLACE FUNCTION public.collapse_guest_person_into(
  _guest_id uuid, _guest_person uuid, _target_person uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF _guest_person = _target_person THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.person_links
             WHERE person_id = _guest_person AND guest_player_id IS DISTINCT FROM _guest_id)
     OR EXISTS (SELECT 1 FROM public.persons WHERE id = _guest_person AND user_id IS NOT NULL) THEN
    RETURN false;
  END IF;
  UPDATE public.person_links SET person_id = _target_person WHERE guest_player_id = _guest_id;
  PERFORM public.rederive_person(_target_person);  -- the merged guest now fills the target's gaps
  UPDATE public.bookings SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.bookings SET paid_by_person_id = _target_person
    WHERE paid_by_guest_player_id = _guest_id AND paid_by_person_id = _guest_person;
  UPDATE public.invoices SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.intake_requests SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET booked_by_person_id = _target_person
    WHERE booked_by_guest_player_id = _guest_id AND booked_by_person_id = _guest_person;
  UPDATE public.session_player_notes SET subject_person_id = _target_person
    WHERE subject_guest_player_id = _guest_id AND subject_person_id = _guest_person;
  UPDATE public.academy_player_locations SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.academy_player_metadata SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  DELETE FROM public.persons WHERE id = _guest_person;
  RETURN true;
END;
$$;

-- H1: a new profile mints its person immediately (signup flow).
CREATE OR REPLACE FUNCTION public.mint_person_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_guest uuid;
  v_guest_person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('guest_email:' || lower(v_email)));
  END IF;
  INSERT INTO public.persons (
    id, user_id, full_name, first_name, last_name, email, phone, birth_date,
    skill_rating, rating_system, rating_member_id, avatar_url, bio, location,
    preferred_language, billing_business_name, billing_address, billing_btw_number,
    stripe_customer_id
  ) VALUES (
    NEW.id, NEW.user_id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
    NEW.skill_rating, NEW.rating_system, NEW.rating_member_id, NEW.avatar_url, NEW.bio, NEW.location,
    NEW.preferred_language, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number,
    NEW.stripe_customer_id
  ) ON CONFLICT (id) DO NOTHING;
  v_person := NEW.id;
  INSERT INTO public.person_links (person_id, profile_id) VALUES (v_person, NEW.id);

  -- Reverse unique email pair — the account-claim flow (guest existed first, the human signs up
  -- with that email later; this shape produced 47 of the 81 pre-backfill matches). Locked rule
  -- (b) evidence at signup time: collapse the guest's person into the new profile's when provably
  -- safe; otherwise leave a pending review row. NEVER keyed on linked_profile_id.
  IF v_email IS NOT NULL
     AND (SELECT count(*) FROM public.profiles p
          WHERE lower(btrim(p.email)) = lower(v_email)
            AND nullif(btrim(p.email), '') IS NOT NULL) = 1
     AND (SELECT count(*) FROM public.guest_players g
          WHERE lower(btrim(g.email)) = lower(v_email)
            AND nullif(btrim(g.email), '') IS NOT NULL) = 1 THEN
    SELECT g.id INTO v_guest FROM public.guest_players g
    WHERE lower(btrim(g.email)) = lower(v_email) AND nullif(btrim(g.email), '') IS NOT NULL;
    SELECT person_id INTO v_guest_person FROM public.person_links WHERE guest_player_id = v_guest;
    IF v_guest_person IS NOT NULL AND v_guest_person <> v_person THEN
      IF public.collapse_guest_person_into(v_guest, v_guest_person, v_person) THEN
        INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
        VALUES ('auto_merged_email_pair', 'applied', v_email, v_guest, NEW.id, v_person,
                jsonb_build_object('via', 'signup_pair'));
      ELSE
        INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, suggested_profile_id, details)
        VALUES ('signup_pair_needs_review', v_email, v_guest, NEW.id, NEW.id,
                jsonb_build_object('reason', 'unique email pair at signup but the guest person is not safely collapsible'));
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mint_person_for_profile ON public.profiles;
CREATE TRIGGER trg_mint_person_for_profile
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.mint_person_for_profile();

-- H2: a new guest joins an existing person when the B1/B2 rules already prove it is the same
--     human at INSERT time (the Phase-0 twin mint inserts guests WITH the stamp, so registered
--     players' twins land on the right person immediately); otherwise it mints its own person.
CREATE OR REPLACE FUNCTION public.mint_person_for_guest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_profile_email text;
  v_guest_count int := 0;
  v_profile_count int := 0;
  v_merged_kind text;
  v_merged_profile uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE guest_player_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Serialize same-email guest inserts: two concurrent inserts of one family email could BOTH
  -- see themselves as the only guest with it and BOTH pass the B2 uniqueness check.
  IF v_email IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('guest_email:' || lower(v_email)));
    SELECT count(*) INTO v_guest_count FROM public.guest_players g
    WHERE lower(btrim(g.email)) = lower(v_email) AND nullif(btrim(g.email), '') IS NOT NULL;
    SELECT count(*) INTO v_profile_count FROM public.profiles p
    WHERE lower(btrim(p.email)) = lower(v_email) AND nullif(btrim(p.email), '') IS NOT NULL;
  END IF;

  -- B1 at insert: explicit twin stamp passing the trust rule
  IF NEW.twin_of_profile_id IS NOT NULL THEN
    SELECT nullif(btrim(p.email), '') INTO v_profile_email
    FROM public.profiles p WHERE p.id = NEW.twin_of_profile_id;
    IF (v_email IS NOT NULL AND v_profile_email IS NOT NULL
        AND lower(v_email) = lower(v_profile_email))
       OR (v_email IS NULL AND NEW.source = 'roster_registered_twin') THEN
      SELECT person_id INTO v_person FROM public.person_links
      WHERE profile_id = NEW.twin_of_profile_id;
      IF v_person IS NOT NULL THEN
        v_merged_kind := 'auto_merged_twin_trust';
        v_merged_profile := NEW.twin_of_profile_id;
      END IF;
    ELSE
      -- an explicit assertion that failed verification is exactly the investigate signal E3
      -- exists for — live inserts must reach the queue too (observability parity)
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, details)
      VALUES ('twin_trust_failure', NEW.email, NEW.id, NEW.twin_of_profile_id,
              jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_insert'));
    END IF;
  END IF;

  -- B2 at insert: this guest is the ONLY guest with this email and exactly one profile has it
  IF v_person IS NULL AND v_email IS NOT NULL
     AND v_guest_count = 1 AND v_profile_count = 1 THEN
    SELECT pl.person_id, pl.profile_id INTO v_person, v_merged_profile
    FROM public.person_links pl
    JOIN public.profiles p ON p.id = pl.profile_id
    WHERE lower(btrim(p.email)) = lower(v_email);
    IF v_person IS NOT NULL THEN
      v_merged_kind := 'auto_merged_email_pair';
    END IF;
  END IF;

  IF v_person IS NULL THEN
    INSERT INTO public.persons (
      id, full_name, first_name, last_name, email, phone, birth_date,
      skill_rating, rating_system, billing_business_name, billing_address, billing_btw_number
    ) VALUES (
      NEW.id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
      NEW.skill_rating, NEW.rating_system, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number
    ) ON CONFLICT (id) DO NOTHING;
    v_person := NEW.id;
  END IF;

  INSERT INTO public.person_links (person_id, guest_player_id) VALUES (v_person, NEW.id);

  IF v_merged_kind IS NOT NULL THEN
    PERFORM public.rederive_person(v_person);  -- the new guest may fill gaps on the merged person
  END IF;

  -- observability parity with the backfill's E report
  IF v_merged_kind IS NOT NULL THEN
    INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
    VALUES (v_merged_kind, 'applied', NEW.email, NEW.id, v_merged_profile, v_person,
            jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_insert'));
  END IF;
  IF v_email IS NOT NULL AND v_guest_count > 1 AND v_merged_kind IS NULL THEN
    INSERT INTO public.person_merge_review (kind, email, guest_player_id, details)
    VALUES ('shared_email_cluster', NEW.email, NEW.id,
            jsonb_build_object('guest_name', NEW.full_name, 'cluster_size', v_guest_count, 'via', 'live_insert'));
  END IF;
  IF v_email IS NOT NULL AND v_profile_count > 1 AND v_merged_kind IS NULL THEN
    INSERT INTO public.person_merge_review (kind, email, guest_player_id, details)
    VALUES ('multi_profile_email', NEW.email, NEW.id,
            jsonb_build_object('guest_name', NEW.full_name, 'profile_count', v_profile_count, 'via', 'live_insert'));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mint_person_for_guest ON public.guest_players;
CREATE TRIGGER trg_mint_person_for_guest
  AFTER INSERT ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.mint_person_for_guest();

-- H3: a twin stamp ADDED later (the claim RPC's compare-and-set) collapses the guest's person
--     into the profile's — but ONLY when the trust rule passes AND the collapse is provably safe
--     (the guest's current person has no login and no other sources). Anything else → review row.
--     A stamp CLEARED on a merged guest (repurpose) cannot be auto-split — review row instead.
CREATE OR REPLACE FUNCTION public.relink_person_on_twin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_guest_person uuid;
  v_profile_person uuid;
  v_email text := nullif(btrim(NEW.email), '');
  v_profile_email text;
  v_trusted boolean := false;
BEGIN
  IF NEW.twin_of_profile_id IS NOT DISTINCT FROM OLD.twin_of_profile_id THEN
    -- No stamp change — but an email move AWAY from the merged profile's email on a guest that
    -- was LINK-merged withOUT a stamp (B2 / signup-pair) is the same repurpose signal the 0c
    -- guard watches for twins: the row may now be a different human, yet its person_links row
    -- keeps stamping the profile's person onto every new booking. Cannot auto-split (existing
    -- rows legitimately belong to the old person) → pending review row.
    IF NEW.twin_of_profile_id IS NULL
       AND lower(btrim(coalesce(NEW.email, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.email, '')))
       AND btrim(coalesce(NEW.email, '')) <> '' THEN
      SELECT pl.person_id INTO v_guest_person
      FROM public.person_links pl WHERE pl.guest_player_id = NEW.id;
      IF v_guest_person IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.person_links pl
        JOIN public.profiles p ON p.id = pl.profile_id
        WHERE pl.person_id = v_guest_person
          AND nullif(btrim(p.email), '') IS NOT NULL
          AND lower(btrim(p.email)) IS DISTINCT FROM lower(btrim(NEW.email))
      ) AND NOT EXISTS (
        SELECT 1 FROM public.person_merge_review r
        WHERE r.guest_player_id = NEW.id
          AND r.kind = 'merged_guest_email_moved' AND r.status = 'pending'
      ) THEN
        INSERT INTO public.person_merge_review (kind, email, guest_player_id, person_id, details)
        VALUES ('merged_guest_email_moved', NEW.email, NEW.id, v_guest_person,
                jsonb_build_object('guest_name', NEW.full_name, 'old_email', OLD.email,
                                   'reason', 'email moved away from the merged profile''s — split may be needed'));
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT person_id INTO v_guest_person FROM public.person_links WHERE guest_player_id = NEW.id;
  IF v_guest_person IS NULL THEN
    RETURN NEW;  -- pre-backfill row without a link; the backfill owns it
  END IF;

  IF NEW.twin_of_profile_id IS NOT NULL AND OLD.twin_of_profile_id IS DISTINCT FROM NEW.twin_of_profile_id THEN
    SELECT person_id INTO v_profile_person FROM public.person_links WHERE profile_id = NEW.twin_of_profile_id;
    IF v_profile_person IS NULL OR v_profile_person = v_guest_person THEN
      RETURN NEW;
    END IF;
    SELECT nullif(btrim(p.email), '') INTO v_profile_email
    FROM public.profiles p WHERE p.id = NEW.twin_of_profile_id;
    v_trusted := (v_email IS NOT NULL AND v_profile_email IS NOT NULL
                  AND lower(v_email) = lower(v_profile_email))
                 OR (v_email IS NULL AND NEW.source = 'roster_registered_twin');
    IF v_trusted AND public.collapse_guest_person_into(NEW.id, v_guest_person, v_profile_person) THEN
      INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, profile_id, person_id, details)
      VALUES ('auto_merged_twin_trust', 'applied', NEW.email, NEW.id, NEW.twin_of_profile_id, v_profile_person,
              jsonb_build_object('guest_name', NEW.full_name, 'via', 'live_claim'));
    ELSE
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, details)
      VALUES (CASE WHEN v_trusted THEN 'twin_detached_needs_split' ELSE 'twin_trust_failure' END,
              NEW.email, NEW.id, NEW.twin_of_profile_id,
              jsonb_build_object('guest_name', NEW.full_name,
                                 'reason', CASE WHEN v_trusted THEN 'guest person not safely collapsible' ELSE 'trust rule failed' END));
    END IF;
  ELSIF NEW.twin_of_profile_id IS NULL AND OLD.twin_of_profile_id IS NOT NULL THEN
    -- stamp cleared (repurpose): if the guest shares a person with a profile, the split needs
    -- human judgment — the rows already stamped carry the merged person.
    IF EXISTS (SELECT 1 FROM public.person_links
               WHERE person_id = v_guest_person AND profile_id IS NOT NULL) THEN
      INSERT INTO public.person_merge_review (kind, email, guest_player_id, profile_id, person_id, details)
      VALUES ('twin_detached_needs_split', NEW.email, NEW.id, OLD.twin_of_profile_id, v_guest_person,
              jsonb_build_object('guest_name', NEW.full_name,
                                 'reason', 'twin stamp cleared on a guest merged into a profile person'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- NOT "UPDATE OF twin_of_profile_id": the repurpose guard (a BEFORE trigger) clears the stamp
-- inside statements whose SET list never mentions the twin column (a rename), and UPDATE OF
-- matches the statement's SET list, not actual changes. Fire on every UPDATE and compare
-- OLD/NEW internally (cheap: one uuid comparison on the fast path).
DROP TRIGGER IF EXISTS trg_relink_person_on_twin_change ON public.guest_players;
CREATE TRIGGER trg_relink_person_on_twin_change
  AFTER UPDATE ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.relink_person_on_twin_change();

-- H4: NO ORPHANED PII COPIES — persons duplicates identity fields from its sources, so when a
--     source row is hard-deleted (GDPR account deletion, trainer erasure, merge_guest_players
--     deleting the merged-away guest) and it was the person's ONLY source, the person must go
--     with it (its stamps SET NULL via the FK — the same anonymization posture the old world gets
--     from nulling player_id/guest_player_id). A person with REMAINING sources stays (deleting an
--     account must not erase the still-coached human — "retain, don't destroy"). BEFORE DELETE so
--     the link row is still readable; deleting the person CASCADEs the link out ahead of the
--     source row's own delete. Phase-3 new-world persons (no links) are never touched.
CREATE OR REPLACE FUNCTION public.cleanup_orphan_person_on_source_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_person uuid;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    SELECT person_id INTO v_person FROM public.person_links WHERE profile_id = OLD.id;
  ELSE
    SELECT person_id INTO v_person FROM public.person_links WHERE guest_player_id = OLD.id;
  END IF;

  -- GDPR: review rows referencing this source must not outlive it as PII copies — drop the
  -- pending queue rows outright and scrub the identifying payload off applied audit rows (the
  -- merge FACT survives; the who does not).
  IF TG_TABLE_NAME = 'profiles' THEN
    DELETE FROM public.person_merge_review
    WHERE (profile_id = OLD.id OR suggested_profile_id = OLD.id) AND status = 'pending';
    UPDATE public.person_merge_review
    SET email = NULL, details = details - 'guest_name' - 'profile_email' - 'old_email'
    WHERE profile_id = OLD.id OR suggested_profile_id = OLD.id;
  ELSE
    DELETE FROM public.person_merge_review
    WHERE guest_player_id = OLD.id AND status = 'pending';
    UPDATE public.person_merge_review
    SET email = NULL, details = details - 'guest_name' - 'profile_email' - 'old_email'
    WHERE guest_player_id = OLD.id;
  END IF;

  IF v_person IS NULL THEN
    RETURN OLD;
  END IF;

  -- Serialize concurrent deletes of a person's last two sources: under READ COMMITTED each
  -- BEFORE trigger could see the other's still-uncommitted cascade and BOTH keep the person —
  -- a permanent zero-link PII orphan. The row lock makes the second deleter re-evaluate after
  -- the first commits.
  PERFORM 1 FROM public.persons WHERE id = v_person FOR UPDATE;

  -- delete the person only when it has NO link other than the one for this source row
  IF NOT EXISTS (
    SELECT 1 FROM public.person_links pl
    WHERE pl.person_id = v_person
      AND NOT (
        -- null-safe: the OTHER source's key column is NULL on this link row, and NOT(NULL) would
        -- silently drop it from the EXISTS (three-valued logic) — IS NOT DISTINCT FROM is exact
        (TG_TABLE_NAME = 'profiles' AND pl.profile_id IS NOT DISTINCT FROM OLD.id)
        OR (TG_TABLE_NAME = 'guest_players' AND pl.guest_player_id IS NOT DISTINCT FROM OLD.id)
      )
  ) THEN
    DELETE FROM public.persons WHERE id = v_person;
  ELSE
    -- The person SURVIVES on other sources — the deleted source's PII must not linger on it.
    -- Drop the dying source's link NOW (the FK cascade would do it anyway, but AFTER this
    -- trigger) so rederive_person sees only the remaining sources: account-only fields go NULL
    -- when the profile dies (user_id freed for re-signup — persons.user_id is UNIQUE), and gap
    -- fields aggregate across ALL remaining guests, not one arbitrary survivor.
    IF TG_TABLE_NAME = 'profiles' THEN
      DELETE FROM public.person_links WHERE profile_id = OLD.id;
    ELSE
      DELETE FROM public.person_links WHERE guest_player_id = OLD.id;
    END IF;
    PERFORM public.rederive_person(v_person);
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_orphan_person_profiles ON public.profiles;
CREATE TRIGGER trg_cleanup_orphan_person_profiles
  BEFORE DELETE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_orphan_person_on_source_delete();

DROP TRIGGER IF EXISTS trg_cleanup_orphan_person_guests ON public.guest_players;
CREATE TRIGGER trg_cleanup_orphan_person_guests
  BEFORE DELETE ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_orphan_person_on_source_delete();

-- ---------------------------------------------------------------------------
-- I) protect_invoice_financial_columns_for_players — person-column exemption
-- ---------------------------------------------------------------------------
-- The live collapse re-stamps invoices.person_id from a SECURITY DEFINER context whose DML caller
-- may BE the invoice's player (an owner-operator manager claiming their own twin). The guard's
-- paid/cancelled lock raised UNCONDITIONALLY for such callers — even for updates that change
-- nothing it protects — hard-failing the claim. person_id is derived identity data with its own
-- guards (the Phase-1 stamp triggers re-derive any forged value), so an update that changes
-- NOTHING but person_id is exempt. Every other protection is byte-identical to 20260530120000.
CREATE OR REPLACE FUNCTION public.protect_invoice_financial_columns_for_players()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_profile_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_player_profile_id := public.get_profile_id_for_user(auth.uid());
  IF v_player_profile_id IS NULL OR NEW.player_id IS DISTINCT FROM v_player_profile_id THEN
    RETURN NEW;
  END IF;

  -- person-column-only updates are exempt (see header)
  IF to_jsonb(NEW) - 'person_id' = to_jsonb(OLD) - 'person_id' THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'invoice_locked'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
    OR NEW.vat_rate IS DISTINCT FROM OLD.vat_rate
    OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.line_items IS DISTINCT FROM OLD.line_items
    OR NEW.vat_breakdown IS DISTINCT FROM OLD.vat_breakdown
    OR NEW.mollie_payment_id IS DISTINCT FROM OLD.mollie_payment_id
    OR NEW.mollie_payment_url IS DISTINCT FROM OLD.mollie_payment_url
    OR NEW.booking_ids IS DISTINCT FROM OLD.booking_ids
    OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.trainer_id IS DISTINCT FROM OLD.trainer_id
    OR NEW.academy_profile_id IS DISTINCT FROM OLD.academy_profile_id
    OR NEW.guest_player_id IS DISTINCT FROM OLD.guest_player_id
    OR NEW.player_id IS DISTINCT FROM OLD.player_id
    OR NEW.player_name IS DISTINCT FROM OLD.player_name
    OR NEW.public_token IS DISTINCT FROM OLD.public_token
    OR NEW.public_token_revoked_at IS DISTINCT FROM OLD.public_token_revoked_at
    OR NEW.forwarded_at IS DISTINCT FROM OLD.forwarded_at
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.prices_include_vat IS DISTINCT FROM OLD.prices_include_vat
  THEN
    RAISE EXCEPTION 'players_may_only_update_billing_fields'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- The collapse helper re-points identity links — DEFINER-internal only (H1/H3 call it as the
-- function owner). Never client-callable: default privileges would have exposed it via PostgREST.
REVOKE ALL ON FUNCTION public.collapse_guest_person_into(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- H5: SOURCE-EDIT SYNC (external re-audit P1) — profiles/guest_players are still the write
--     surfaces until Phase 3/4, so every edit (EditProfile, trainer/academy player edits, edge
--     fns) must re-derive the person or Phase-3 readers would serve stale names/phones/ratings.
--     Fast-path guarded: only fires rederive when a derivation-relevant field actually changed
--     (twin/link/ownership churn never re-derives).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_person_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (NEW.user_id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone,
      NEW.birth_date, NEW.skill_rating, NEW.rating_system, NEW.rating_member_id, NEW.avatar_url,
      NEW.bio, NEW.location, NEW.preferred_language, NEW.billing_business_name,
      NEW.billing_address, NEW.billing_btw_number, NEW.stripe_customer_id)
     IS DISTINCT FROM
     (OLD.user_id, OLD.full_name, OLD.first_name, OLD.last_name, OLD.email, OLD.phone,
      OLD.birth_date, OLD.skill_rating, OLD.rating_system, OLD.rating_member_id, OLD.avatar_url,
      OLD.bio, OLD.location, OLD.preferred_language, OLD.billing_business_name,
      OLD.billing_address, OLD.billing_btw_number, OLD.stripe_customer_id) THEN
    PERFORM public.rederive_person(pl.person_id)
    FROM public.person_links pl WHERE pl.profile_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_person_from_profile ON public.profiles;
CREATE TRIGGER trg_sync_person_from_profile
  AFTER UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_person_from_profile();

CREATE OR REPLACE FUNCTION public.sync_person_from_guest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
      NEW.skill_rating, NEW.rating_system, NEW.billing_business_name, NEW.billing_address,
      NEW.billing_btw_number)
     IS DISTINCT FROM
     (OLD.full_name, OLD.first_name, OLD.last_name, OLD.email, OLD.phone, OLD.birth_date,
      OLD.skill_rating, OLD.rating_system, OLD.billing_business_name, OLD.billing_address,
      OLD.billing_btw_number) THEN
    PERFORM public.rederive_person(pl.person_id)
    FROM public.person_links pl WHERE pl.guest_player_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_person_from_guest ON public.guest_players;
CREATE TRIGGER trg_sync_person_from_guest
  AFTER UPDATE ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_person_from_guest();
