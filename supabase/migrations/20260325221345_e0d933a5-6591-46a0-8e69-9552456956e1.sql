
ALTER TABLE public.invoices ADD COLUMN prices_include_vat boolean NOT NULL DEFAULT true;

-- Backfill: invoices where total > line_items sum have VAT-exclusive prices
-- We can detect this by checking if total ≈ subtotal + vat_amount and subtotal ≈ line_items sum
-- For invoices with vat_amount > 0: if total > subtotal, prices were exclusive
UPDATE public.invoices
SET prices_include_vat = false
WHERE vat_amount > 0
  AND total > (
    SELECT COALESCE(SUM((item->>'quantity')::numeric * (item->>'unit_price')::numeric), 0)
    FROM jsonb_array_elements(line_items::jsonb) AS item
  ) + 0.05;
