-- div-009: split_payment was stored in TWO places that could drift —
-- cycles.settings.split_payment (JSON) and availability_slots.split_payment
-- (column). The upfront Mollie path read the cycle while the invoice path read
-- the slot column, so a drifted cycle produced contradictory charges (one player
-- billed the per-head share, another the full amount).
--
-- Scalable fix: make the CYCLE the single write authority and have Postgres
-- enforce the invariant — a trigger mirrors cycles.settings.split_payment onto
-- the cycle's slots, so the column can never disagree with the cycle no matter
-- which code path writes (now or in future). Standalone slots (no cyclus_id)
-- keep the column as their own authority. Reads of the slot column are now
-- always correct for cycle slots.

-- (1) Cycle settings change → mirror to all linked slots.
CREATE OR REPLACE FUNCTION public.sync_cycle_split_payment_to_slots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE((OLD.settings->>'split_payment')::boolean, false)
     IS DISTINCT FROM COALESCE((NEW.settings->>'split_payment')::boolean, false) THEN
    UPDATE public.availability_slots
       SET split_payment = COALESCE((NEW.settings->>'split_payment')::boolean, false)
     WHERE cyclus_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cycle_split_payment ON public.cycles;
CREATE TRIGGER trg_sync_cycle_split_payment
  AFTER UPDATE ON public.cycles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_cycle_split_payment_to_slots();

-- (2) Slot inserted or (re)linked to a cycle → inherit the cycle's value, so a
--     hand-added agenda session linked to a cycle can't carry a stale setting.
--     Fires only when cyclus_id is set/changed (NOT on the mirror above, which
--     updates split_payment only), so the two triggers never recurse.
CREATE OR REPLACE FUNCTION public.inherit_cycle_split_payment_on_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_split boolean;
BEGIN
  IF NEW.cyclus_id IS NOT NULL THEN
    SELECT COALESCE((settings->>'split_payment')::boolean, false)
      INTO v_split
      FROM public.cycles
     WHERE id = NEW.cyclus_id;
    IF v_split IS NOT NULL THEN
      NEW.split_payment := v_split;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inherit_cycle_split_payment ON public.availability_slots;
CREATE TRIGGER trg_inherit_cycle_split_payment
  BEFORE INSERT OR UPDATE OF cyclus_id ON public.availability_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.inherit_cycle_split_payment_on_slot();

-- (3) One-time reconcile: repair any slot already drifted from its cycle.
UPDATE public.availability_slots s
   SET split_payment = COALESCE((c.settings->>'split_payment')::boolean, false)
  FROM public.cycles c
 WHERE s.cyclus_id = c.id
   AND COALESCE(s.split_payment, false)
       IS DISTINCT FROM COALESCE((c.settings->>'split_payment')::boolean, false);
