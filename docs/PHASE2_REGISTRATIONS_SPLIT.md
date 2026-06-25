# Phase 2 — Registration ↔ Cycle split: migration spec (for review before anything runs)

> Owner rules honoured: **never touch the 1009 bookings / 322 slots / their invoices**; **additive only** (no DROP/DELETE/move of data); registration up-front **payment preserved**; clubs read-only; one shared model for academy+trainer.

## The core insight (why this is low-risk)
Verified against the code: after the split, **the existing `cycles` row stays the owner of its slots, bookings, invoices, and `intake_requests.cycle_id`.** It simply gets *re-designated* as the training cycle. The "registration" becomes a **new, lightweight `registrations` row** holding only the intake-form config. Therefore:
- **Proposals + finalize-proposals: NO CHANGE** — they key on `intake_requests.cycle_id` and `availability_slots.cyclus_id`, both of which keep pointing at the same (now-training) cycle.
- **Bookings / slots / invoices: NEVER written by this migration.**
- The only writes are: create N `registrations` rows, add a nullable `registration_id` to ~92 `intake_requests` + the registration/event `invoices`, and flip `cycles.type` on the **2** cycles that actually own training.

## Production scope (from the data-health run)
`type IN ('registration','event')` cycles get a `registrations` row each. Only **2** also own training (so only 2 get the `type→'cyclus'` flip):
- "Padeltrainingen zomer 2026" — 322 slots, **1009 bookings**, 77 intakes.
- "Tennistrainingen zomer 2026" — 44 slots, 0 bookings, 15 intakes.

## Target end-state
- `cycles` = training series only (`type='cyclus'`). Owns slots/bookings/pricing. The 2 dual-role rows become `type='cyclus'` (their slots/bookings unchanged).
- `registrations` (NEW) = the intake form (config + `intake_requests` via additive `registration_id` + registration/event invoices via additive `registration_id`). Carries `source_cycle_id` back to the cycle it split from.
- `intake_requests.cycle_id` keeps pointing at the (now-training) cycle → proposals keep working. `registration_id` (new, nullable) points at the form.

---

## Step 1 — Schema (additive migration, owner-applied)
1. **`CREATE TABLE public.registrations`** — columns: `id`, `source_cycle_id uuid REFERENCES cycles(id) ON DELETE RESTRICT`, `owner_type`, `owner_id`, `format text CHECK (format IN ('registration','event'))`, `name`, `description`, `enrollment_deadline`, `status`, `total_price`, `currency`, `price_table jsonb`, `location_id`, `settings jsonb` (the FORM keys only: lesson_types, custom_lesson_types, show_preferred_trainer, show_price_indication, cyclus_options, duration_options, available_duration_minutes, price_columns, prices_include_vat, success_message, confirmation_email_text, payment_methods, min/max_skill_rating, applicable_trainer_ids), `created_at`, `updated_at`. Indexes on source_cycle_id / owner / status.
2. **RLS on `registrations`** mirroring `cycles`: public SELECT where `status='open'`; trainer/academy/club owner SELECT+INSERT+UPDATE+DELETE via the existing `trainer_profiles` / `get_user_academy_ids` / `get_user_club_ids` helpers. Clubs are read-only in the UI (no club create/edit surfaces), but the owner policy stays symmetric.
3. **`ALTER TABLE invoices ADD COLUMN registration_id uuid` (nullable)** + index. (Keep `cycle_id`.)
4. **`ALTER TABLE intake_requests ADD COLUMN registration_id uuid` (nullable)** + index. (Keep `cycle_id`.)

No DROP, no NOT NULL yet (backfill first). types.ts regen needed (owner, post-apply) — new table + 2 columns + the FK Relationship.

## Step 2 — Code lands FIRST (expand-migrate-contract; deploy before Step 3)
New code must read **both** shapes so the `type` flip in Step 3 is safe while old data/links exist:
- `new src/lib/registrations.ts` + a `getRegistration(id)` resolver that accepts EITHER a registration id (new, canonical) OR a legacy cycle id (resolve via `registrations WHERE source_cycle_id = :id`). Files: `CycleRegistration.tsx`, `BrandedCycleRegistration.tsx`.
- `submit-guest-intake`: determine "is this a paid registration/event?" from the registration (new) OR `cycles.type` (legacy) → **payment minting preserved**. `event-registration-invoice.ts` writes `registration_id` AND keeps `cycle_id`.
- `AcademyRegistrations` + `getCyclesWithCounts`: read registration/event rows from `registrations`, training from `cycles`.
- **Unchanged (verified):** `generate-proposals`, `finalize-proposals`, slot/booking reads, the Mollie webhook + PDF + `/pay` (they key off `invoices.public_token`/`id`, never the cycle).

## Step 2b — Public links, QR codes & redirects (owner decision: forms still live → full link migration + redirects)
The public form URL is built in **`src/lib/cycleRegistrationUrl.ts`** (single helper) and consumed by `RegistrationQrDialog.tsx`, `CyclesTable.tsx`, `AcademyCycleDetail`, `AcademyOpenCycles`, `LocationOpenCycles`, `TrainerOpenCycles`. Routes: `/register/:cycleId`, `/academies/:slug/register/:cycleId`, `/clubs/:slug/register/:cycleId`.
- **New canonical URL = the registration id.** Update `cycleRegistrationUrl.ts` (and its call sites + `RegistrationQrDialog`) to emit `…/register/<registrationId>`. Newly displayed links, copy-link buttons, and freshly generated **QR codes** all carry the new id automatically.
- **Redirect for everything already out there** (distributed links + already-printed QR codes): the form page resolves the `:cycleId`/`:id` param as a registration id OR (legacy) a cycle id → `source_cycle_id` → registration; when it resolved via a legacy id, it `navigate(canonicalUrl, { replace: true })` so the URL cleans up and the form still serves. So old QR codes/links keep working forever via this resolve-and-redirect.
- **Owner action after deploy:** regenerate the QR codes / re-share the new links for the live forms (the app now emits the new canonical URL); old printed QR codes continue to work via the redirect.

## Step 3 — Backfill (ONE transaction, self-rolling-back)
Run as a single `BEGIN … COMMIT` with verification before COMMIT; any mismatch → `ROLLBACK` (zero data loss, no restore needed). Backup snapshot taken first as the catastrophic backstop.

```sql
BEGIN;

-- (a) one registrations row per registration/event cycle (copy form config; source_cycle_id back-ref).
-- start_date/end_date are copied too (added in 20260628100100): per-lesson forms price as
-- (price × weeks) where weeks falls back to the start→end span, so the span must travel with the form
-- or post-backfill those forms preview + charge €0. Also copy created_at so list ordering is preserved.
INSERT INTO public.registrations (id, source_cycle_id, owner_type, owner_id, format, name, description,
       start_date, end_date, enrollment_deadline, status, total_price, currency, price_table, location_id,
       settings, created_at)
SELECT gen_random_uuid(), c.id, c.owner_type, c.owner_id, c.type, c.name, c.description,
       c.start_date, c.end_date, c.enrollment_deadline, c.status, c.total_price, c.currency,
       c.price_table, c.location_id,
       -- copy only the FORM keys out of cycles.settings (training keys stay on the cycle):
       (select jsonb_object_agg(k, c.settings->k) from unnest(ARRAY[
          'lesson_types','custom_lesson_types','show_preferred_trainer','show_price_indication',
          'cyclus_options','duration_options','available_duration_minutes','price_columns',
          'prices_include_vat','success_message','confirmation_email_text','payment_methods',
          'min_skill_rating','max_skill_rating','applicable_trainer_ids'
       ]) k where c.settings ? k),
       c.created_at
FROM public.cycles c
WHERE c.type IN ('registration','event')
  AND NOT EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = c.id);  -- idempotent

-- (b) link intake_requests + invoices to their new registration (additive; keep cycle_id)
UPDATE public.intake_requests ir SET registration_id = r.id
FROM public.registrations r WHERE r.source_cycle_id = ir.cycle_id AND ir.registration_id IS NULL;

UPDATE public.invoices i SET registration_id = r.id
FROM public.registrations r WHERE r.source_cycle_id = i.cycle_id AND i.registration_id IS NULL;

-- (c) re-designate ONLY the registration/event cycles that actually own training as training cycles.
--     (Their slots/bookings are untouched — they already reference this id.)
UPDATE public.cycles c SET type = 'cyclus'
WHERE c.type IN ('registration','event')
  AND EXISTS (SELECT 1 FROM public.availability_slots s WHERE s.cyclus_id = c.id);

-- (d) VERIFY in-transaction — any failure → ROLLBACK (see checks below). Example guard:
DO $$
DECLARE bad int;
BEGIN
  -- every intake/invoice that had a registration source must now be linked
  SELECT count(*) INTO bad FROM public.intake_requests ir
   JOIN public.cycles c ON c.id = ir.cycle_id            -- cycle still exists
   WHERE ir.registration_id IS NULL
     AND EXISTS (SELECT 1 FROM public.registrations r WHERE r.source_cycle_id = ir.cycle_id);
  IF bad > 0 THEN RAISE EXCEPTION 'unlinked intake_requests: %', bad; END IF;
  -- (repeat for invoices; and assert booking/slot counts unchanged vs the pre-migration baseline)
END $$;

COMMIT;
```

## Step 4 — Verification (in-transaction + post-commit)
- **No data lost:** `bookings`, `availability_slots`, `invoices`, `intake_requests`, `cycles` row counts **≥** the pre-migration baseline (from `docs/DATA_HEALTH_CHECKS.md`).
- **Bookings untouched:** count of bookings + their `slot_id`s unchanged; the 2 cycles' slot counts (322 / 44) unchanged.
- **Links resolve:** every `intake_requests.registration_id` / `invoices.registration_id` resolves to a registration whose `source_cycle_id` = the row's `cycle_id`.
- **Re-designation:** exactly the 2 training-owning cycles are now `type='cyclus'`; pure-form registration cycles keep their type (deprecated shadow).
- **Payment intact:** pick a paid registration invoice → its `public_token` still resolves + shows paid; webhook unaffected.

## Step 5 — Rollback (trivial, because additive)
Nothing destructive happened, so rollback is: `UPDATE cycles SET type = <original> WHERE id IN (the 2)`; the `registrations` rows + `registration_id` columns can be left in place harmlessly or cleared. The today-backup is the only-if-catastrophic backstop (note: a full restore loses the write-window, so it's the last resort, not the first line).

## Sequencing summary
1. Snapshot/backup prod. 2. Ship Step 1 (schema) + Step 2 (dual-read code), owner applies migration + regens types. 3. Verify the app works on both shapes. 4. Run Step 3 backfill (transactional). 5. Step 4 verify. 6. Later (separate, optional, much later): "contract" — stop dual-reading, retire the form keys from `cycles.settings`. Adversarial review of the Step 3 SQL before it runs.

## Owner decision (resolved)
The forms are **still live**. We **fully migrate the links** (new canonical URL = registration id), the app emits new links + QR codes automatically (Step 2b), and **already-distributed links + printed QR codes keep working via the resolve-and-redirect** (legacy cycle id → `source_cycle_id` → registration). Owner re-shares the new links / regenerates QR codes for the live forms after deploy.
