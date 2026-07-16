-- Phase 0c round-3 fix (third external audit): clear_guest_twin_on_repurpose was created WITHOUT
-- SECURITY DEFINER (20260826240000), but its email-away branch reads public.profiles.email. A
-- trigger function without DEFINER runs with the DML caller's privileges, and base `profiles` rows
-- are PII-protected under RLS — an academy manager/trainer editing a guest row from the client
-- (EditPlayerDialog, saveAcademyPlayerDetails) generally CANNOT read the twin profile's row. The
-- EXISTS then silently evaluated false and the email-only repurpose guard no-oped on exactly the
-- common path (it did work via merge_guest_players, whose DEFINER context masked the bug — and the
-- PGlite suite ran as superuser, so it couldn't catch it either; an RLS-role regression test now
-- exercises this for real).
--
-- DEFINER here leaks nothing: the function returns no data — the profile-email comparison only
-- decides whether to null a column — and managers in scope already see registered players' emails
-- through get_players_overview (the sanctioned source). Body identical to 20260826240000;
-- CREATE OR REPLACE keeps the existing trigger binding.
CREATE OR REPLACE FUNCTION public.clear_guest_twin_on_repurpose()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.twin_of_profile_id IS NOT NULL
     AND NEW.twin_of_profile_id IS NOT DISTINCT FROM OLD.twin_of_profile_id
     AND (
       -- a name change without an explicit re-stamp = the row may now be a different human
       NEW.full_name IS DISTINCT FROM OLD.full_name
       OR NEW.first_name IS DISTINCT FROM OLD.first_name
       OR NEW.last_name IS DISTINCT FROM OLD.last_name
       -- an email moved AWAY from the twin profile's email (the canonical person merge key).
       -- Kept: case/whitespace-only changes, corrections TOWARD the profile's email, emptying
       -- the email, and twins of emailless profiles (nothing to validate against).
       OR (
         lower(btrim(coalesce(NEW.email, ''))) IS DISTINCT FROM lower(btrim(coalesce(OLD.email, '')))
         AND btrim(coalesce(NEW.email, '')) <> ''
         AND EXISTS (
           SELECT 1 FROM public.profiles p
           WHERE p.id = OLD.twin_of_profile_id
             AND nullif(btrim(p.email), '') IS NOT NULL
             AND lower(btrim(p.email)) IS DISTINCT FROM lower(btrim(NEW.email))
         )
       )
     ) THEN
    NEW.twin_of_profile_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
