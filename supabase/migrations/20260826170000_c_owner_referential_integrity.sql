-- Theme C (audit R22): cycles.owner_id and registrations.owner_id are polymorphic
-- (owner_type ∈ trainer|club|academy) with NO foreign key — the core tenant→program linkage had
-- zero referential integrity. An orphan owner_id was insertable, and deleting an owner (e.g. the
-- admin academy-delete flow, which cleans up trainers/invitations/mollie but not programs) left
-- invisible zombie cycles/registrations: every RLS policy filters owner_id IN (SELECT …), so an
-- orphaned program matches NO owner and becomes unmanageable while still carrying slots/intake.
--
-- A polymorphic column cannot carry a real FK. Rather than the typed-column rewrite (which would
-- touch ~194 app usages, 15 RLS policies and 8 DB functions for a representation change), enforce
-- the SAME two invariants a FK would give, at the DB layer, additively:
--   (1) INSERT/UPDATE: the owner must exist in the table owner_type names (like FK insert-side);
--   (2) DELETE of an owner is REFUSED while it still owns programs (like ON DELETE RESTRICT),
--       with an actionable message — deleting an academy's programs must be a deliberate act,
--       never a silent orphaning (mirrors Theme A's block-don't-automate philosophy).
-- Zero app-surface change; current data is untouched (prod verified: 0 orphans). Both checks are
-- constant-time: (1) is a PK lookup, (2) uses the existing idx_cycles_owner /
-- idx_registrations_owner (owner_type, owner_id) btrees — so this holds at volume.
--
-- deleteUserData is compatible by construction: it deletes a trainer's/org's cycles BEFORE the
-- owner row is touched, and since Theme A the trainer row is anonymized (UPDATE), never deleted.

-- (1) Owner must exist on INSERT / owner-change UPDATE.
CREATE OR REPLACE FUNCTION public.enforce_program_owner_exists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF NEW.owner_type = 'trainer' THEN
    SELECT EXISTS (SELECT 1 FROM public.trainer_profiles t WHERE t.id = NEW.owner_id) INTO v_exists;
  ELSIF NEW.owner_type = 'club' THEN
    SELECT EXISTS (SELECT 1 FROM public.club_profiles c WHERE c.id = NEW.owner_id) INTO v_exists;
  ELSIF NEW.owner_type = 'academy' THEN
    SELECT EXISTS (SELECT 1 FROM public.academy_profiles a WHERE a.id = NEW.owner_id) INTO v_exists;
  ELSE
    -- owner_type CHECK constraint already rejects other values; belt-and-braces.
    v_exists := false;
  END IF;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'owner % % does not exist for % row', NEW.owner_type, NEW.owner_id, TG_TABLE_NAME
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'cycles/registrations must reference an existing trainer_profiles/club_profiles/academy_profiles row (audit R22).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cycles_owner_exists ON public.cycles;
CREATE TRIGGER trg_cycles_owner_exists
  BEFORE INSERT OR UPDATE OF owner_id, owner_type ON public.cycles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_program_owner_exists();

DROP TRIGGER IF EXISTS trg_registrations_owner_exists ON public.registrations;
CREATE TRIGGER trg_registrations_owner_exists
  BEFORE INSERT OR UPDATE OF owner_id, owner_type ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_program_owner_exists();

-- (2) An owner that still owns programs cannot be deleted (RESTRICT semantics).
CREATE OR REPLACE FUNCTION public.guard_owner_has_no_programs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type text := TG_ARGV[0];
  v_cycles int;
  v_registrations int;
BEGIN
  SELECT count(*) INTO v_cycles
    FROM public.cycles WHERE owner_type = v_type AND owner_id = OLD.id;
  SELECT count(*) INTO v_registrations
    FROM public.registrations WHERE owner_type = v_type AND owner_id = OLD.id;

  IF v_cycles > 0 OR v_registrations > 0 THEN
    RAISE EXCEPTION 'cannot delete %: it still owns % cycle(s) and % registration(s)', v_type, v_cycles, v_registrations
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Delete or transfer the owner''s cycles/registrations first — deleting an owner must never silently orphan its programs (audit R22).';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_trainer_owner_programs_guard ON public.trainer_profiles;
CREATE TRIGGER trg_trainer_owner_programs_guard
  BEFORE DELETE ON public.trainer_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_has_no_programs('trainer');

DROP TRIGGER IF EXISTS trg_club_owner_programs_guard ON public.club_profiles;
CREATE TRIGGER trg_club_owner_programs_guard
  BEFORE DELETE ON public.club_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_has_no_programs('club');

DROP TRIGGER IF EXISTS trg_academy_owner_programs_guard ON public.academy_profiles;
CREATE TRIGGER trg_academy_owner_programs_guard
  BEFORE DELETE ON public.academy_profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_owner_has_no_programs('academy');
