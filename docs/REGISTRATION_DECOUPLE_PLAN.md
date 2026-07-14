# Registration ↔ Cycle Decoupling — Plan & Tracker

**Goal:** A *registration* is a standalone intake **form** (collect applicant details). A *cycle* is the training you **plan** registrants into. Creating a form must NOT create a cycle — planning does.

**Why now:** registration forms are live and the overlay-on-a-cycle-shell coupling is generating bugs (stale public form after edit, "close" not closing, blank prices, forms masquerading as training cycles). Only 10 forms exist, so migration effort is minimal.

## Current model (before)
- `registrations` = overlay row, 1:1 FK `source_cycle_id → cycles` (shell born `type='cyclus'`), ~13 duplicated columns kept in sync by dual-write RPCs.
- `intake_requests.cycle_id` → the shell (NOT NULL). `intake_requests.registration_id` exists (nullable, 277/292 set).
- Public form reads the overlay; planning (proposals→finalize→bookings) runs on the same shell.
- Data: 10 forms all have overlay rows; 0 legacy stragglers; 15 intakes need `registration_id` backfill (one form).

## Target model (after)
- `registrations` = first-class form table (already owns all needed columns).
- Public form + submit + admin form surfaces read/write `registrations` by its own `id`.
- `intake_requests.registration_id` NOT NULL = canonical "which form".
- `intake_requests.cycle_id` nullable = "planned into this training cycle" (NULL until planned).
- Cycle created at PLANNING time; the existing proposal→finalize→booking engine runs unchanged on that cycle.
- `source_cycle_id` coupling removed (nullable → eventually dropped); existing 10 shells stay as their already-planned cycles.

---

## Phase 1 — stop the live bleeding
- [x] **P1.1** `CycleCard` close bug — sync overlay status on status change (was accepting sign-ups on a "closed" form). `src/components/cycles/CycleCard.tsx`.
- [~] **P1.2** forms masquerading as training cycles in academy overview / rebook-source picker — FOLDED into Phase 2 (root cause removed there).
- [~] **P1.3** guard `generate-cycle-commitment-invoices` against registration shells — FOLDED into Phase 2 / audit F04 (same file).

## Phase 2 — decouple (staged, each step locally verified; owner applies migrations & deploys)
- [x] **2a Data foundation** — migration `20260823100000`: auto-derive trigger + backfill + `registration_id NOT NULL` + FK→CASCADE + `(registration_id, player_id)` unique. Rehearsal `registrationDecoupleIntakeLink.pglite.test.ts` (6/6). Non-destructive; owner applies.

**Decisions locked:** registrations = FREE intake (no sign-up payment); events (format='event') CAN charge at sign-up → need `invoices.registration_id` anchor; MIGRATE ALL 10 forms to shell-less. Enabler: 0 forms planned (0 slots/0 bookings). 2 forms carry invoices (Jeugd Boemerang 13 paid; Kids event 1 cancelled) → repoint to `invoices.registration_id` before deleting shells. FK topology: `intake_requests.cycle_id` → cycles CASCADE (must null before shell delete); `registrations.source_cycle_id` → cycles CASCADE (detach first); `invoices.cycle_id` → SET NULL.

### BACKEND MIGRATIONS — ALL BUILT + REHEARSED (owner applies together) ✅
- [x] **2c-schema/RPCs** — `20260823110000`: `source_cycle_id` nullable + `create_registration`/`update_registration` RPCs (owner-authed, form-only settings, no shell).
- [x] **2d + 2f data** — `20260823120000`: `invoices.registration_id` anchor + backfill; `intake_requests.cycle_id` nullable; intake-target guard → `registration_id`; `source_cycle_id` FK dropped (kept as legacy-URL alias); the 10 empty shells detached + deleted (guarded: unplanned only). Rehearsal `registrationDecoupleShellCleanup.pglite.test.ts` 7/7.
- [x] **RLS + counts** — `20260823130000`: `intake_requests` owner policies repointed cycle_id→registration_id (12 policies → 4 via `user_owns_registration`); `count_registrations_intakes`. SECURITY rehearsal `registrationIntakeRls.pglite.test.ts` 5/5 (cross-tenant isolation holds with cycle_id NULL).

### FRONTEND + EDGE WIRING — DONE (deploys WITH the migrations; verified 60 vitest + 216 deno)
- [x] **2c/2b wire** — `registrations.ts`: writers → `create_registration`/`update_registration` RPCs; `registrationToCycle` exposes `registration.id`; `syncRegistrationStatus`/`updateRegistration` accept id-or-alias; `listRegistrationCycles` reads the table + `count_registrations_intakes`. `CycleForm` drops the shell-fallback; `CycleFormPage` presents the registration-as-cycle so edits update (not create). `useCycleDetailQuery` + `getCycle` callers fall back to the registration (fixes blank-price detail).
- [x] **2d wire** — `submitIntakeRequest` + `createManualIntakeRequest` insert `registration_id`+null `cycle_id`, resolve owner from the registration; `submit-guest-intake` edge fn resolves the form by id/alias, inserts `registration_id`, anchors event invoices to `registration_id`; `create-registration-invoice` repointed to `intake.registration_id`; shared `event-registration-invoice` dedups + anchors on `registration_id`.
- [x] **counts/reads** — `getIntakeRequestCounts`, `getIntakeRequests`, `getIntakeRequestsByOwner`, intake-page filters → `registration_id`; `IntakeRequest` type gains `registration_id`, `cycle_id` nullable.

### STILL REMAINING (both safe follow-ups, not data-critical)
- [ ] **Retire the form-attached "Generate proposals" UI** (planning moves to Phase 3). Currently it fails SAFELY — generate-proposals returns 404 "Cycle not found" for a registration id before creating any slots (no data risk), so it's a broken button, not corruption. Hide the wizard/generate/reset on `TrainerIntakeRequests` + `AcademyIntakeRequests`.
- [ ] Regenerate `src/integrations/supabase/types.ts` AFTER the migrations apply (so `intake_requests.cycle_id` is nullable + `registration_id`/`invoices.registration_id` exist).

---

## DEPLOY — data-safety checklist (coordinated; migrations + code together)

**Order matters. Migrations `20260823100000` → `110000` → `120000` → `130000` apply in filename order. Deploy the frontend + edge functions in the SAME release.**

### Pre-deploy (confirm the migration's assumptions still hold — run read-only)
```sql
-- A) No form has been planned (shell delete guard depends on this). Expect 0, 0.
SELECT count(*) FILTER (WHERE s.n>0) forms_with_slots, count(*) FILTER (WHERE b.n>0) forms_with_bookings
FROM public.registrations r JOIN public.cycles c ON c.id=r.source_cycle_id
LEFT JOIN LATERAL (SELECT count(*) n FROM availability_slots s WHERE s.cyclus_id=c.id) s ON true
LEFT JOIN LATERAL (SELECT count(*) n FROM bookings b JOIN availability_slots s ON s.id=b.slot_id WHERE s.cyclus_id=c.id) b ON true;
-- B) Every registration/event form has an overlay (registration_id NOT NULL is safe). Expect 0.
SELECT count(*) FROM public.cycles c WHERE c.type IN ('registration','event')
  AND NOT EXISTS(SELECT 1 FROM public.registrations r WHERE r.source_cycle_id=c.id);
-- C) Snapshot counts to compare after. Note these numbers.
SELECT (SELECT count(*) FROM registrations) forms, (SELECT count(*) FROM intake_requests) intakes,
       (SELECT count(*) FROM invoices WHERE cycle_id IN (SELECT source_cycle_id FROM registrations)) form_invoices;
```
If A≠0,0 → STOP (a form was planned; the shell-delete guard will skip it, but investigate first).

### Apply
1. `supabase db push` (applies the 4 migrations in order). The shell delete is guarded (unplanned-only) and repoints intakes/invoices first.
2. Deploy edge functions: `submit-guest-intake`, `create-registration-invoice` (+ shared `event-registration-invoice`).
3. Deploy the frontend.
4. Regenerate types: `supabase gen types typescript --linked > src/integrations/supabase/types.ts` (post-migration).

### Post-deploy verification (expect: nothing lost)
```sql
-- Intakes preserved + all linked to a form (registration_id NOT NULL now).
SELECT count(*) total, count(*) FILTER (WHERE registration_id IS NULL) unlinked FROM intake_requests;  -- unlinked = 0
-- Paid invoices preserved + repointed (Jeugd Boemerang had 13 paid).
SELECT count(*) FILTER (WHERE status='paid') paid, count(*) FILTER (WHERE registration_id IS NOT NULL) anchored FROM invoices WHERE registration_id IS NOT NULL;
-- Shells gone; forms standalone (source_cycle_id kept as alias).
SELECT count(*) FROM cycles c JOIN registrations r ON r.source_cycle_id=c.id;  -- expect 0 (shells deleted)
```
Then smoke-test in the app: open a form's public /register page, submit a test intake, confirm it appears in the owner's intake list with the right count, and (for an event) that the pay-link mints.

### Rollback
Migrations are forward-only. The shell DELETE is the only destructive step — but it runs LAST and only after intakes/invoices are repointed, and only for shells with 0 slots/0 bookings. If a post-deploy issue appears, the data (intakes, invoices, forms) is intact; revert the frontend/edge deploy and the app falls back to reading `registrations` (which still resolves by id + source_cycle_id alias). Keep a pre-deploy DB backup/snapshot regardless.
- [ ] **2e Planning entry — RETIRED from the form** (owner decision 2026-07-14): a registration NEVER creates slots/cycles. Planning moves to a future Phase-3 "planning board" (applicant pool ⟷ available slots, drag to assign, reuse quick-session generator + proposal engine). Phase 2 removes the form-attached proposal entry; the underlying slot/booking engine stays intact.
- [ ] **2f Data migration + cleanup** — add `invoices.registration_id` + backfill the 2 forms; null shell-linked intakes' `cycle_id`; drop `source_cycle_id` FK (keep column as legacy-URL alias); delete the 10 empty shells; retire dead plumbing (write-only `terms`, missing-RPC fallback, dual-write RPCs).

**Phase 3 (next, own design round): planning board** — pool of applicants (across forms, filter by lesson type/availability/rating) ⟷ available slots (rebook leftovers + "generate new sessions"); drag-to-assign sets `intake_requests.cycle_id` + booking; optional AI auto-suggest. Registrations stay pure collection.

## Verification per step
- Local: `npm run typecheck:baseline`, `eslint`, vitest, pglite rehearsals; new tests for the new invariants.
- Owner applies migrations (`supabase db push`) and deploys the frontend/edge functions.
