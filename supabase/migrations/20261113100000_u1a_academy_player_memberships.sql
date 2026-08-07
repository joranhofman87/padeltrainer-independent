-- U1a — the EMPTY additive canonical academy–Player membership skeleton.
-- Foundation programme slice U1a (docs branch: FOUNDATION_EXECUTION_PLAN.md / FOUNDATION_DECISIONS.md,
-- owner decisions OD-03 2026-08-07 + shape confirmation and OD-09/OD-10 2026-08-08).
--
-- One canonical relationship per (academy, person). A focused relationship ROOT: no notes, status,
-- tags, billing, trainer assignment, settings, or merge logic here — those arrive only with later,
-- separately reviewed slices (repeating data via membership-linked child tables). NOTHING reads or
-- writes this table in U1a: no reader/writer switch, no dual-write, no backfill. Population is a
-- later owner-gated unit and requires the OD-10 membership-aware merge/repoint command first.
--
-- FK behavior (approved, OD-10):
--   * person_id → persons(id) ON DELETE RESTRICT — a Player row is never hard-deletable while a
--     membership exists (retention/anonymization keeps the stable Player UUID; OD-08 governs fields).
--   * academy_profile_id → academy_profiles(id) ON DELETE CASCADE — academy deletion removes its own
--     private membership rows via the audited academy-deletion flow. Financial/booking evidence lives
--     in other tables and is NOT touched by this cascade.
--
-- Access: default-deny from creation. RLS is ENABLED with ZERO policies (the persons/person_links
-- pattern — the absence of policies IS the control), and, because this project's ALTER DEFAULT
-- PRIVILEGES auto-grants table privileges to anon/authenticated/service_role BY NAME (and
-- service_role additionally carries BYPASSRLS), the named-role REVOKE below is load-bearing — a bare
-- `REVOKE ... FROM PUBLIC` would not remove those grants. No role is granted anything back in U1a:
-- later server commands re-grant deliberately, under review.

CREATE TABLE public.academy_player_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL
    REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  person_id uuid NOT NULL
    REFERENCES public.persons(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academy_player_memberships_academy_person_key
    UNIQUE (academy_profile_id, person_id)
);

-- Person-leading index: Player-side lookups, FK RESTRICT checks, and the future OD-10 repoint all
-- enter by person_id; the UNIQUE above only serves academy-leading access.
CREATE INDEX idx_academy_player_memberships_person
  ON public.academy_player_memberships (person_id);

CREATE TRIGGER update_academy_player_memberships_updated_at
  BEFORE UPDATE ON public.academy_player_memberships
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.academy_player_memberships ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.academy_player_memberships FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.academy_player_memberships IS
  'U1a foundation skeleton: one canonical academy–Player relationship per (academy_profile_id, person_id). EMPTY by design — no reader, writer, or backfill until the later owner-gated population unit (OD-10 lifecycle command required first). Default-deny: RLS on, zero policies, all named-role privileges revoked.';
