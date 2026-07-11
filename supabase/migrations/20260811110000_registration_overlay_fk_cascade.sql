-- ============================================================================
-- registrations.source_cycle_id FK: RESTRICT → CASCADE (audit Batch 1, §3.1 "delete is broken")
-- ============================================================================
-- The registrations overlay's FK to its cycle shell was ON DELETE RESTRICT (20260628100000). No
-- code ever deletes the overlay, so deleting a SPLIT registration (deleteCycle → DELETE the cycles
-- shell) errored with a foreign_key_violation — the registration became undeletable.
--
-- The overlay is an implementation detail of its shell (1:1, source_cycle_id UNIQUE), so it should
-- follow the shell out the door: switch to ON DELETE CASCADE. Deleting the cycle now cleans up its
-- overlay automatically. (Slot / booking / claim orphaning on delete is a SEPARATE concern — the
-- availability_slots.cyclus_id FK is ON DELETE SET NULL; that + delete-user-data are audit §4.2/§4.6,
-- Batch 6.) Name-agnostic drop so it works regardless of the auto-generated constraint name.
-- ============================================================================

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.registrations'::regclass
    AND contype = 'f'
    AND conkey = (
      SELECT ARRAY[attnum] FROM pg_attribute
      WHERE attrelid = 'public.registrations'::regclass AND attname = 'source_cycle_id'
    );

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.registrations DROP CONSTRAINT %I', v_conname);
  END IF;

  ALTER TABLE public.registrations
    ADD CONSTRAINT registrations_source_cycle_id_fkey
    FOREIGN KEY (source_cycle_id) REFERENCES public.cycles(id) ON DELETE CASCADE;
END $$;
