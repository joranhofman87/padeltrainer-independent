-- Theme A / R03 (audit, HIGH — financial-record loss on trainer deletion).
--
-- Deleting a trainer HARD-DELETED their invoices + every booking on their slots. delete-user-data's
-- trainer branch explicitly deletes availability_slots (→ bookings.slot_id CASCADE erases the
-- bookings) and invoices; and even without those, trainer_profiles.user_id → auth.users ON DELETE
-- CASCADE means the final auth deleteUser() cascades the trainer + all its financial children away.
-- NL law requires invoices be retained ~7 years and players paid Mollie for those bookings; nothing
-- (archival/RESTRICT/soft-delete) protected any of it.
--
-- Retain-in-place via an anonymized SHELL trainer_profiles row (the agreed model). Keeping the row
-- keeps every financial FK valid (invoices.trainer_id, availability_slots.trainer_id → bookings), so
-- nothing cascades. The money-bearing FKs also move off CASCADE so a direct/future trainer delete
-- can't erase invoices, and so the shell outlives the auth-user deletion:
--   1) trainer_profiles.user_id  CASCADE -> SET NULL (+ DROP NOT NULL): the shell survives auth-user
--      deletion, detached from the removed login.
--   2) invoices.trainer_id       CASCADE -> SET NULL: a direct trainer_profiles delete detaches the
--      invoice instead of erasing it (the shell normally keeps the link intact).
--   3) invoices.guest_player_id  NO ACTION -> SET NULL: now that invoices are RETAINED, they no
--      longer BLOCK the trainer's guest_players (students) deletion. The issued invoice keeps the
--      customer name/address it denormalized at issue time (a legal record); the guest master row is
--      still erased.
--   4) trainer_profiles.anonymized_at stamp marks the shell.
--
-- NOTE (documented residual): availability_slots.trainer_id stays ON DELETE CASCADE (it is NOT NULL;
-- dropping that to SET NULL would ripple through the hot slots table). Slot bookings are therefore
-- retained by NEVER hard-deleting trainer_profiles (delete-user-data now anonymizes it). A direct
-- out-of-band trainer_profiles hard-delete would still cascade its slots' bookings; invoices remain
-- protected by (2).

ALTER TABLE public.trainer_profiles
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

COMMENT ON COLUMN public.trainer_profiles.anonymized_at IS
  'Theme A/R03: set when the trainer account was deleted — the row is retained as an anonymized shell (PII nulled, user_id detached, is_public false) so its financial children (invoices, slots→bookings) keep valid FKs and are not cascade-erased.';

-- 1) The shell must outlive the deleted auth user.
ALTER TABLE public.trainer_profiles ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.trainer_profiles DROP CONSTRAINT IF EXISTS trainer_profiles_user_id_fkey;
ALTER TABLE public.trainer_profiles
  ADD CONSTRAINT trainer_profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2) A trainer delete detaches invoices instead of erasing them.
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_trainer_id_fkey;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_trainer_id_fkey
  FOREIGN KEY (trainer_id) REFERENCES public.trainer_profiles(id) ON DELETE SET NULL;

-- 3) Retained invoices no longer block erasing the trainer's guest players.
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_guest_player_id_fkey;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_guest_player_id_fkey
  FOREIGN KEY (guest_player_id) REFERENCES public.guest_players(id) ON DELETE SET NULL;
