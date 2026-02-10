

## Bundle Cyclus on Invoices, Add Logo Upload, and Custom Invoice Numbering

### 1. Bundle cyclus bookings on invoices

**Current behavior:** When a cyclus booking creates an invoice, every session gets its own line item (e.g., "Summer Training - 10/02/2026 09:00", "Summer Training - 17/02/2026 09:00", etc.).

**New behavior:** Cyclus bookings are collapsed into a single line item showing:
- Description: cyclus name/description
- Quantity: number of sessions (weeks)
- Unit price: price per session
- Total: quantity x unit price

Extra costs from `cycle.settings.extra_costs` remain as separate line items below.

Standalone (non-cyclus) bookings remain unchanged as individual line items.

**Files changed:**
- `supabase/functions/auto-create-invoice/index.ts` -- rewrite line item building logic: detect if all bookings share the same `cyclus_id`, if so create one bundled line item instead of N individual ones
- `supabase/functions/generate-invoice/index.ts` -- remove the per-item date display for bundled cyclus items (date column not shown when quantity > 1 and it's a cyclus)
- `src/components/trainer/CreateInvoiceDialog.tsx` -- no change needed (manual invoices already allow custom line items)

---

### 2. Logo upload on invoice settings

**Database migration:**
- Add `invoice_logo_url text` column to `trainer_profiles`
- Academy invoices will use `academy_profiles.logo_url` (already exists)

**Storage:** Use the existing `avatars` bucket (public) for invoice logos, stored under a subfolder like `invoice-logos/{user_id}.png`.

**UI changes:**
- `src/components/trainer/InvoiceSettingsCard.tsx` -- add a logo upload section at the top of the card with image preview, upload button, and remove button

**PDF changes:**
- `supabase/functions/generate-invoice/index.ts` -- fetch `invoice_logo_url` from `trainer_profiles`, render it in the top-left of the invoice HTML header (replacing or alongside the "FACTUUR" title). For academy trainers, fall back to `academy_profiles.logo_url`.

---

### 3. Custom invoice numbering

**Database migration:**
- Add `invoice_prefix text DEFAULT 'INV'` to `trainer_profiles`
- Add `invoice_next_number integer DEFAULT 1` to `trainer_profiles`

This lets trainers set their own prefix (e.g., "FACT", "PT", their initials) and starting number. The format stays `{prefix}-{year}-{sequence}` (e.g., "PT-2026-0001").

**UI changes:**
- `src/components/trainer/InvoiceSettingsCard.tsx` -- add a "Factuurnummering" section with:
  - Prefix input (e.g., "INV", "FACT", "PT")
  - Next number input (auto-incremented, but editable)
  - Live preview showing what the next invoice number will look like

**Backend changes:**
- `supabase/functions/auto-create-invoice/index.ts` -- use `trainer_profiles.invoice_prefix` and query based on that prefix pattern instead of hardcoded `INV`
- `src/components/trainer/CreateInvoiceDialog.tsx` -- same: use the trainer's custom prefix when generating invoice numbers

---

### Technical details

**Migration SQL:**
```sql
ALTER TABLE trainer_profiles ADD COLUMN invoice_logo_url text;
ALTER TABLE trainer_profiles ADD COLUMN invoice_prefix text DEFAULT 'INV';
ALTER TABLE trainer_profiles ADD COLUMN invoice_next_number integer DEFAULT 1;
```

**Storage policy:** Invoice logos are uploaded to the public `avatars` bucket under `invoice-logos/` path -- reuses existing upload policies that check `auth.uid()`.

**auto-create-invoice line item bundling logic:**
```text
if all bookings share the same cyclus_id:
  -> 1 line item: { description: cyclus_name, quantity: bookings.length, unit_price: price_per_session }
  -> plus any extra_costs as separate line items
else:
  -> individual line items per booking (current behavior)
```

**generate-invoice HTML changes:**
- Logo rendered as `<img>` in the header div, max-height 60px, alongside "FACTUUR" title
- Bundled cyclus items: show quantity as session count, no per-row date

**Files affected (summary):**
1. `supabase/functions/auto-create-invoice/index.ts` -- bundled line items + custom prefix
2. `supabase/functions/generate-invoice/index.ts` -- logo in PDF + bundled display
3. `src/components/trainer/InvoiceSettingsCard.tsx` -- logo upload + prefix/numbering UI
4. `src/components/trainer/CreateInvoiceDialog.tsx` -- use custom prefix for manual invoices
5. Database migration (3 new columns on `trainer_profiles`)
6. i18n files (EN/NL trainer) for new labels

