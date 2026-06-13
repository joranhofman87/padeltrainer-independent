-- div-007 hardening: availability_slots.max_participants could be NULL, and the
-- client surfaces defaulted it inconsistently (4 on player/academy, 1 on the
-- trainer calendar — now unified to getSlotCapacity = 4 in the app). Back the
-- shared default with the database so NULL stops reaching the client at all:
-- repair existing NULLs and default new rows to 4 (a padel court).
--
-- Deliberately NOT adding NOT NULL: some server insert paths type the column as
-- nullable, and a hard NOT NULL would reject an explicit null insert. The
-- DEFAULT + backfill removes every NULL in practice without that risk (and keeps
-- the generated column type unchanged, so no types drift).

UPDATE public.availability_slots
   SET max_participants = 4
 WHERE max_participants IS NULL;

ALTER TABLE public.availability_slots
  ALTER COLUMN max_participants SET DEFAULT 4;
