-- D-01 (AUDIT-2026-06): 159 academy invoices (Mar 25 – Jun 4 era) have
-- line_items whose objects lack the `amount` field. Display was always correct
-- (every renderer computes quantity × unit_price), so this is a pure shape
-- backfill: amount := round(quantity * unit_price, 2). Per-row exception
-- handling: a malformed row is skipped with a NOTICE instead of aborting.

DO $$
DECLARE
  inv record;
  fixed integer := 0;
  skipped integer := 0;
  new_items jsonb;
BEGIN
  FOR inv IN
    SELECT id, line_items FROM public.invoices
    WHERE jsonb_typeof(line_items) = 'array'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(line_items) e
        WHERE jsonb_typeof(e.value) = 'object' AND NOT (e.value ? 'amount')
      )
  LOOP
    BEGIN
      SELECT jsonb_agg(
        CASE
          WHEN jsonb_typeof(item) = 'object' AND NOT (item ? 'amount') THEN
            item || jsonb_build_object(
              'amount',
              round(
                coalesce(nullif(item->>'quantity','')::numeric, 1)
                * coalesce(nullif(item->>'unit_price','')::numeric, 0),
                2
              )
            )
          ELSE item
        END
        ORDER BY ord
      )
      INTO new_items
      FROM jsonb_array_elements(inv.line_items) WITH ORDINALITY AS t(item, ord);

      UPDATE public.invoices SET line_items = new_items WHERE id = inv.id;
      fixed := fixed + 1;
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped + 1;
      RAISE NOTICE 'D-01 backfill skipped invoice % (%: %)', inv.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'D-01 backfill: % invoices fixed, % skipped', fixed, skipped;
END $$;
