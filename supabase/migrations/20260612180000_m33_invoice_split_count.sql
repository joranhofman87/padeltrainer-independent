-- M-33 (Wave 4, FORWARD-ONLY by maintainer decision): store the split-payment
-- divisor structurally instead of only inside the "(1/N)" text in line-item
-- descriptions (a regex on display strings drives money math; a cycle named
-- e.g. "Groep (1/2)" would corrupt recalculations).
--
-- NULL = legacy invoice → readers fall back to the "(1/N)" regex indefinitely.
-- Existing invoices are intentionally NOT backfilled and never rewritten.

ALTER TABLE public.invoices
  ADD COLUMN split_count integer
  CHECK (split_count IS NULL OR split_count >= 1);

COMMENT ON COLUMN public.invoices.split_count IS
  'Split-payment divisor (price shown is 1/N of the group total). NULL on invoices created before 2026-06-12: readers must fall back to the (1/N) marker in line_items descriptions.';
