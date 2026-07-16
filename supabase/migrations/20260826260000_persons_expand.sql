-- ============================================================================
-- Person unification — PHASE 1: EXPAND (docs/PERSON_UNIFICATION_PLAN.md §5)
-- ============================================================================
-- Additive only, ZERO behavior change, fully reversible (nothing reads the new columns yet):
--   1. `persons` — the future canonical human ("has a login" = user_id IS NOT NULL). Created
--      EMPTY; Phase 2 backfills. RLS enabled with NO policies → invisible to clients until
--      Phase 3 adds deliberate read policies.
--   2. `person_links` — the identity map old-world → new-world: one row per absorbed source row
--      (a profile or a guest), each source mappable at most once. Phase 2 populates it; the
--      dual-write triggers read it. Same RLS lockdown.
--   3. Nullable `*person_id` columns on the 7 dual-keyed tables (9 column-pairs: bookings +
--      slot_priority_claims carry a second pair) — FK → persons, ON DELETE SET NULL.
--   4. Dual-write triggers: the person columns are PURE DERIVED DATA on every row that carries
--      (or carried) an old-world key — recomputed from person_links whenever the trigger fires,
--      never trusted from the writer. With person_links empty (now), every stamp is NULL — i.e.
--      literally no change until Phase 2 backfills the map.
--
-- Doctrine notes (learned in Phase 0c): the trigger functions are SECURITY DEFINER because they
-- read the RLS-locked person_links from arbitrary caller contexts — a non-DEFINER trigger would
-- silently stamp NULL for RLS-restricted writers (the round-3 bug class; the pglite suite tests
-- this under a restricted role). RETURNS trigger functions are not PostgREST-callable, so DEFINER
-- exposes nothing. Identity truth for Phase 2 remains the trust rule — NEVER linked_profile_id.

-- ---------------------------------------------------------------------------
-- 1) persons (target schema per plan §4.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.persons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,  -- "has a login"
  full_name         text,
  first_name        text,
  last_name         text,
  email             text,       -- NOT globally unique (families); account uniqueness lives in auth.users
  phone             text,
  birth_date        date,
  skill_rating      numeric,
  rating_system     text,
  rating_member_id  text,
  avatar_url        text,
  bio               text,
  location          text,
  preferred_language text,
  billing_business_name text,
  billing_address   text,
  billing_btw_number text,
  stripe_customer_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;  -- no policies yet: client-invisible

DROP TRIGGER IF EXISTS trg_persons_updated_at ON public.persons;
CREATE TRIGGER trg_persons_updated_at
  BEFORE UPDATE ON public.persons
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Phase 2's exact-email matching key (mirrors idx_guest_players_lower_email).
CREATE INDEX IF NOT EXISTS idx_persons_lower_email
  ON public.persons (lower(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';

-- ---------------------------------------------------------------------------
-- 2) person_links — the old→new identity map (one source row → exactly one person)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.person_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  profile_id       uuid UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  guest_player_id  uuid UNIQUE REFERENCES public.guest_players(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- exactly ONE source per link row
  CONSTRAINT person_links_exactly_one_source CHECK (
    (profile_id IS NOT NULL)::int + (guest_player_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_person_links_person ON public.person_links (person_id);

ALTER TABLE public.person_links ENABLE ROW LEVEL SECURITY;  -- no policies: definer/service only

-- ---------------------------------------------------------------------------
-- 3) nullable person columns on the 7 dual-keyed tables (9 pairs)
-- ---------------------------------------------------------------------------
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_by_person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booked_by_person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.session_player_notes
  ADD COLUMN IF NOT EXISTS subject_person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.academy_player_locations
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;
ALTER TABLE public.academy_player_metadata
  ADD COLUMN IF NOT EXISTS person_id uuid REFERENCES public.persons(id) ON DELETE SET NULL;

-- FK-side indexes (partial: the columns stay NULL until Phase 2) so future reads and the
-- ON DELETE SET NULL fan-out never table-scan the money tables.
CREATE INDEX IF NOT EXISTS idx_bookings_person ON public.bookings (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_paid_by_person ON public.bookings (paid_by_person_id) WHERE paid_by_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_person ON public.invoices (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_requests_person ON public.intake_requests (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spc_person ON public.slot_priority_claims (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spc_booked_by_person ON public.slot_priority_claims (booked_by_person_id) WHERE booked_by_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spn_subject_person ON public.session_player_notes (subject_person_id) WHERE subject_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apl_person ON public.academy_player_locations (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apm_person ON public.academy_player_metadata (person_id) WHERE person_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) dual-write triggers (one function per table; SECURITY DEFINER — see header)
-- ---------------------------------------------------------------------------
-- Stamping rule per (profile-key, guest-key) → person-column pair — DERIVED, NEVER TRUSTED
-- (external-verification round: honoring writer-provided person ids would have made the columns
-- forgeable — the 7 tables are client-UPDATEable under existing RLS and the financial-column
-- guard triggers don't cover the new columns):
--   * whenever the row HAS an old-world key (or HAD one before this statement), the person column
--     is recomputed from person_links — a client writing person_id directly just gets it
--     re-derived (the person columns are in the trigger OF-lists for exactly this reason);
--   * keys removed (retention/anonymization sets them NULL) → derives NULL: no stale person
--     survives anonymization;
--   * a row with NO old-world keys at all (a Phase-3 new-world row) is writer-managed — the
--     trigger never touches it.
-- Lookup is GUEST-side first (verification finding): the guest key is the row's ORIGINAL subject;
-- player_id on both-keyed rows is only ever added later by the email linkers via
-- linked_profile_id — the inference banned from identity decisions. On a divergent both-keyed row
-- (guest maps to person A, profile to person B) the guest side must win; profile-first would let
-- the banned inference overwrite the correct subject.

CREATE OR REPLACE FUNCTION public.stamp_person_id_bookings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.player_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id)
    );
  END IF;
  IF NEW.paid_by_player_id IS NOT NULL OR NEW.paid_by_guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.paid_by_player_id IS NOT NULL OR OLD.paid_by_guest_player_id IS NOT NULL)) THEN
    NEW.paid_by_person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.paid_by_guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.paid_by_player_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_bookings ON public.bookings;
CREATE TRIGGER trg_stamp_person_id_bookings
  BEFORE INSERT OR UPDATE OF player_id, guest_player_id, paid_by_player_id, paid_by_guest_player_id,
                            person_id, paid_by_person_id
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_bookings();

CREATE OR REPLACE FUNCTION public.stamp_person_id_invoices()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.player_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_invoices ON public.invoices;
CREATE TRIGGER trg_stamp_person_id_invoices
  BEFORE INSERT OR UPDATE OF player_id, guest_player_id, person_id
  ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_invoices();

CREATE OR REPLACE FUNCTION public.stamp_person_id_intake_requests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.player_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_intake_requests ON public.intake_requests;
CREATE TRIGGER trg_stamp_person_id_intake_requests
  BEFORE INSERT OR UPDATE OF player_id, guest_player_id, person_id
  ON public.intake_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_intake_requests();

CREATE OR REPLACE FUNCTION public.stamp_person_id_slot_priority_claims()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.player_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.player_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.player_id)
    );
  END IF;
  IF NEW.booked_by_player_id IS NOT NULL OR NEW.booked_by_guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.booked_by_player_id IS NOT NULL OR OLD.booked_by_guest_player_id IS NOT NULL)) THEN
    NEW.booked_by_person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.booked_by_guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.booked_by_player_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_slot_priority_claims ON public.slot_priority_claims;
CREATE TRIGGER trg_stamp_person_id_slot_priority_claims
  BEFORE INSERT OR UPDATE OF player_id, guest_player_id, booked_by_player_id, booked_by_guest_player_id,
                            person_id, booked_by_person_id
  ON public.slot_priority_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_slot_priority_claims();

CREATE OR REPLACE FUNCTION public.stamp_person_id_session_player_notes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.subject_profile_id IS NOT NULL OR NEW.subject_guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.subject_profile_id IS NOT NULL OR OLD.subject_guest_player_id IS NOT NULL)) THEN
    NEW.subject_person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.subject_guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.subject_profile_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_session_player_notes ON public.session_player_notes;
CREATE TRIGGER trg_stamp_person_id_session_player_notes
  BEFORE INSERT OR UPDATE OF subject_profile_id, subject_guest_player_id, subject_person_id
  ON public.session_player_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_session_player_notes();

CREATE OR REPLACE FUNCTION public.stamp_person_id_academy_player_locations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.profile_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.profile_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.profile_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_academy_player_locations ON public.academy_player_locations;
CREATE TRIGGER trg_stamp_person_id_academy_player_locations
  BEFORE INSERT OR UPDATE OF profile_id, guest_player_id, person_id
  ON public.academy_player_locations
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_academy_player_locations();

CREATE OR REPLACE FUNCTION public.stamp_person_id_academy_player_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.profile_id IS NOT NULL OR NEW.guest_player_id IS NOT NULL
     OR (TG_OP = 'UPDATE' AND (OLD.profile_id IS NOT NULL OR OLD.guest_player_id IS NOT NULL)) THEN
    NEW.person_id := COALESCE(
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.guest_player_id = NEW.guest_player_id),
      (SELECT pl.person_id FROM public.person_links pl WHERE pl.profile_id = NEW.profile_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_person_id_academy_player_metadata ON public.academy_player_metadata;
CREATE TRIGGER trg_stamp_person_id_academy_player_metadata
  BEFORE INSERT OR UPDATE OF profile_id, guest_player_id, person_id
  ON public.academy_player_metadata
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_person_id_academy_player_metadata();
