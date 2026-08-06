-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- OD-1 (owner decision, 2026-08-06) — A TRAINER OWNS THEIR OWN LOGIN.
--
-- "An academy manager may manage a trainer's membership, academy-specific role and permissions,
--  but must never directly change that trainer's global login identity, login email, password or
--  credentials. The trainer owns their identity and changes it through self-service. An academy
--  may initiate an invitation, email-change confirmation or password-reset flow. A separately
--  authorized platform-administrator recovery path may exist, but it must be audited. This applies
--  even when one manager currently manages every academy to which the trainer belongs."
--
-- `update-user` now refuses every manager caller. This migration is why that refusal is a RULE and
-- not just one endpoint's manners: the check lives at the mutation boundary, so the next endpoint,
-- RPC or script that writes `profiles.email` inherits it without having to remember.
--
-- WHAT IT DOES NOT TOUCH. Name, phone, bio, avatar, ratings — a manager writing those is refused by
-- the endpoint under OD-1, but they are not credentials and a database-level block would break the
-- player-management surfaces that legitimately maintain them for guests and academy players. The
-- credential is the thing that must not move, and it is the thing this guards.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.profiles_login_identity_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid;
BEGIN
  IF NEW.email IS NOT DISTINCT FROM OLD.email THEN
    RETURN NEW;                       -- not an identity change; nothing to say about it
  END IF;

  BEGIN
    v_uid := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_uid := NULL;
  END;

  -- the trainer themselves: this is the self-service path the decision points people to
  IF v_uid IS NOT NULL AND v_uid = OLD.user_id THEN
    RETURN NEW;
  END IF;

  -- the audited platform-administrator recovery path
  IF v_uid IS NOT NULL AND public.has_role(v_uid, 'admin') THEN
    RETURN NEW;
  END IF;

  -- service_role with NO end-user JWT: the signup / invitation / auth-callback machinery.
  --
  -- WHAT THIS BRANCH CANNOT SEE, stated plainly rather than assumed away: an edge function that
  -- authenticates a manager with a user client and then WRITES with an admin client arrives here
  -- with no JWT, and is allowed. The trigger is defence in depth against a direct write carrying a
  -- manager's own token; it is NOT the whole boundary, and it cannot guard GoTrue's auth.users at
  -- all. The endpoint is the boundary for privileged service-role paths, which is why
  -- `academy-update-player-email` carries its own trainer refusal and `update-user` refuses every
  -- manager caller outright. A new privileged path must do the same — this trigger will not catch
  -- it for you.
  IF v_uid IS NULL AND current_setting('request.jwt.claim.sub', true) IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NULL AND coalesce(current_setting('request.jwt.claim.sub', true), '') = '' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'profiles.email is a login credential and belongs to its owner: only that person, or an administrator through the audited recovery path, may change it. An academy can send an invitation or a password-reset link instead.';
END $$;

COMMENT ON FUNCTION public.profiles_login_identity_guard() IS
  'OD-1: profiles.email is a login credential. Only the account holder or a platform admin may change it; a tenant manager may only INITIATE a flow the trainer completes. Enforced at the mutation boundary so it survives the next endpoint that forgets.';

DROP TRIGGER IF EXISTS trg_profiles_login_identity_guard ON public.profiles;
CREATE TRIGGER trg_profiles_login_identity_guard
  BEFORE UPDATE OF email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_login_identity_guard();
