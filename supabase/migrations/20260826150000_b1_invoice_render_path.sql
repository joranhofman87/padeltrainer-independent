-- Theme B / B1 (audit R05+R23 keystone): invoices never durably knew WHERE their rendered
-- HTML+PDF live. `pdf_url` stores a 1-hour SIGNED URL, and both generate-invoice and
-- forward-invoice re-derive the object path as `folderKey/invoice_number` (folderKey = trainer
-- user_id || academy_profile_id || 'custom') — duplicated logic, and nothing a GC could target
-- deterministically. Renumbering drafts moves the key and permanently orphans the old objects;
-- academy-folder objects can't even be matched by the bucket's auth.uid()-keyed RLS (R23), so
-- lifecycle is service-role-only by design.
--
-- `render_path` = the storage key PREFIX (`<folder>/<invoice_number>`; the `.html`/`.pdf`
-- suffixes are fixed). generate-invoice stamps it on every upload; forward-invoice prefers it
-- over derivation; renumbering nulls it (the old objects become unmatched). The B2 GC deletes
-- only bucket objects that match NO invoice's render_path (after a 90-day grace) — so this
-- column is the ground truth that keeps every live render safe.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS render_path text;

COMMENT ON COLUMN public.invoices.render_path IS
  'Theme B: storage key prefix of this invoice''s rendered HTML+PDF in the ''invoices'' bucket (<folder>/<invoice_number>; suffixes .html/.pdf). Stamped by generate-invoice on upload, nulled on draft renumber. The storage GC (B2) deletes only objects matching NO invoice''s render_path — NULL means "no render known", never "delete my render".';

-- BACKFILL pass 1 — exact expected path, verified against the ACTUAL bucket contents: only stamp
-- the derived path when that object really exists (an invoice whose render was never generated,
-- or that lives under an old key, keeps NULL rather than claiming a path that isn't there).
UPDATE public.invoices i
SET render_path = expected.path
FROM (
  SELECT i2.id,
         COALESCE(
           (SELECT tp.user_id::text FROM public.trainer_profiles tp WHERE tp.id = i2.trainer_id),
           i2.academy_profile_id::text,
           'custom'
         ) || '/' || i2.invoice_number AS path
  FROM public.invoices i2
  WHERE i2.render_path IS NULL AND i2.invoice_number IS NOT NULL
) expected
WHERE i.id = expected.id
  AND EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'invoices' AND o.name = expected.path || '.pdf'
  );

-- BACKFILL pass 2 — renders stranded under an OLD key (e.g. the owning trainer was deleted, so
-- the shell's user_id is NULL and pass 1 derived a folder the object never lived in). Match by
-- invoice_number across folders, but only for UNAMBIGUOUS pairs: invoice numbers repeat across
-- tenants, and a wrong cross-tenant match would hand invoice A's render to invoice B — so require
--   (a) the invoice matches exactly ONE object,
--   (b) that object matches NO other unstamped invoice, and
--   (c) the object is not already claimed by any invoice's render_path (a pass-1 winner).
-- Anything ambiguous stays NULL and surfaces in the GC's report-only phase for manual review.
WITH pairs AS (
  SELECT i2.id AS invoice_id, o.name
  FROM public.invoices i2
  JOIN storage.objects o
    ON o.bucket_id = 'invoices'
   AND o.name LIKE '%/' || i2.invoice_number || '.pdf'
  WHERE i2.render_path IS NULL AND i2.invoice_number IS NOT NULL
),
uniq AS (
  SELECT invoice_id, min(name) AS name
  FROM pairs
  GROUP BY invoice_id
  HAVING count(*) = 1
)
UPDATE public.invoices i
SET render_path = regexp_replace(u.name, '\.pdf$', '')
FROM uniq u
WHERE i.id = u.invoice_id
  AND NOT EXISTS (
    SELECT 1 FROM pairs p2 WHERE p2.name = u.name AND p2.invoice_id <> u.invoice_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.invoices ix WHERE ix.render_path = regexp_replace(u.name, '\.pdf$', '')
  );
