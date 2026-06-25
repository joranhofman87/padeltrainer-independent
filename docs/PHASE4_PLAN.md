# PHASE 4 PLAN — REVISED (scalable · reusable · characterization-first)

> Supersedes `/Users/tom/Cursor/padeltrainer/docs/PHASE4_PLAN.md`. Same end-state (admin write surfaces agree with live public read surfaces; unified slot edit/delete; slot=price-source; club read-only; shared academy↔trainer components), but **re-sequenced and split** so every slice provably meets the owner's three hard requirements. The original's 9 slices were correct in *intent* but several were untestable-as-written, hid per-slot loops, and assumed shared components that don't exist yet. The revision front-loads three **foundation slices** that gate the risky money/data work.

---

## 1. WHAT CHANGED vs the original 9-slice plan, and why

The three lenses force three structural changes:

**(a) NEW foundation slices inserted BEFORE the risky refactors.** The original jumped from "write API" (Slice 1) straight into editor/detail rewrites and slot edit/delete RPCs with no harness to prove zero-breakage and no scalable data access to build on. Three foundations are now extracted as their own PRs:

- **F1 — characterization harness + 10k fixture** (`src/test/fixtures/`, shared Supabase mock builder). Locks pricing math, settings split, and slot edit/delete cascade *before* any refactor. The test-lens found 22–30 characterization tests must exist first; today there is no fixture factory and no RTL pattern for `CycleForm`/slot dialogs.
- **F2 — set-based slot RPCs + paginated/aggregated reads** (`apply_slot_edit_to_cycle`, `apply_slot_delete_to_cycle`, `get_cyclus_groups_paginated`, `count_cycles_intakes`, `update_cycle_pricing` extended to return invoice-sync counts). The scale-lens found the current code loads all 10k slots client-side (`AcademyCyclusOverview` fetch loop, lines 175-197), aggregates client-side (lines 200-530), and bulk-updates in a 500-chunk client loop (lines 722-728) that is **non-atomic**. Every risky slice below depends on these existing first.
- **F3 — shared-component skeletons** (`components/slots/SlotEditDialog`, `components/slots/DeleteSlotDialog`, `components/registrations/RegistrationForm` wiring). The reuse-lens found the original assumed these were shared; in reality `DeleteSlotDialog` lives in `components/trainer/` (academy *inlines* a duplicate at `AcademySlotDetail.tsx:517-588`), and slot EDIT is implemented three divergent times. The skeletons are extracted as inert, props-injected components first, then adopted.

**(b) Re-sequencing: tests + scale foundations first.** New order puts F1→F2→F3 ahead of everything except the zero-risk interim guard. The original's "Slice 0 first" survives (it stops the divergence bleed), but real refactors wait for foundations.

**(c) Splitting slices too big to test well.** Three originals are split:
- Original **Slice 4** (registration edit *and* detail read *and* write switch) → **4a read-resolve** + **4b write-switch**. The write switch is the single highest-divergence-risk change; it gets its own PR + adversarial review with the settings-split golden locked in 4a.
- Original **Slice 7** (shared slot EDIT) → **7a extract+adopt dialog (no behavior change)** + **7b transactional apply-to-cycle RPC**. Lets us prove the UI extraction is pixel/behavior-identical before touching money.
- Original **Slice 8** (slot=price) → **8a route bulk-price through the atomic RPC (kill the client loop)** + **8b deepen: derive cycle total + recompute split_count**. 8a is the scale-critical, lower-risk half; 8b is the owner-gated depth question.

Net: **9 slices → 3 foundations + 12 slices**. More, smaller, each independently testable with scalable data access.

---

## 2. THE REVISED SLICE LIST (dependency-ordered)

### Slice 0 — Interim divergence guard (UI-safe, ship FIRST)
- **Goal.** Stop stale form-config writes immediately. `CycleForm.tsx` (onSubmit ~526-637) + `CycleFormPage.tsx` (load ~212): if `getRegistration(cycleId)` returns a row, disable the form-config fields with a banner. No new write path.
- **Scalability.** One `getRegistration` call (already two indexed `maybeSingle` lookups on `registrations.id` / `source_cycle_id`). No slot access at all. N/A at scale.
- **Reusability.** Lives in the already-shared `CycleForm` (neutral `components/cycles/`); both academy and trainer get the guard for free via the existing `ownerType` path. No new component.
- **Tests.** Characterization: none needed (additive guard). After: 2 unit (`isRegistrationFlipped` helper true iff a row resolves; banner-condition), 1 component (RTL render flipped cycle → fields `disabled`, banner visible). ~3 tests.
- **Risk.** LOW, pure UI. No adversarial review. No deploy. Owner decision needed: disable-fields vs mirror-to-registration variant (see §5).

### Foundation F1 — Characterization harness + 10k fixture (gates everything)
- **Goal.** Build the test infrastructure the riskier slices need, and lock current behavior of the three money/data cores. No production code changes.
- **Deliverables.**
  - `src/test/fixtures/factory.ts` — minimal `Cycle`/`Registration`/`Slot`/`Booking`/`Invoice` builders + a `makeCycleWith(n)` that synthesizes 10,000 slots / 5,000 bookings for scale/perf assertions.
  - `src/test/fixtures/supabaseMock.ts` — chainable Supabase query/RPC mock (extracted from the pattern already in `registrations.test.ts`), so RPC slices share one harness.
  - **Golden characterization files** (lock-before-refactor):
    - `registrations.golden.ts` — the FORM-ONLY key allowlist (cutover.sql 99-120) + a populated `Registration` → expected `updateRegistration` write.
    - `settingsSplit.golden.ts` — form-only vs training-only key partition; `listRegistrationCycles` merge output.
    - `pricing.math.golden.ts` — snapshot `computeRegistrationCharge` line-items/subtotal/vat/vatBreakdown for the 10-week / multi-rate / flat-package matrix (extends the existing Deno `registrationPricing.test.ts`).
    - `slotEditCascade.golden.ts` / `slotDeleteCascade.golden.ts` — capture **today's** behavior including the known academy "cyclus-slot price skip" bug, so 7b/8 can prove the fix is intentional and the rest is unchanged.
- **Scalability.** The fixture is itself the 10k harness; perf assertions (no load-all, paginated query shape) are written here and reused by F2/8a.
- **Reusability.** Harness is consumed by every later slice's tests, academy and trainer alike.
- **Tests.** This slice *is* tests: ~22–30 characterization + the fixture/mock utilities.
- **Risk.** LOW (no prod code). No adversarial review. No deploy.

### Foundation F2 — Set-based slot RPCs + paginated/aggregated reads (gates 4,6,7,8)
- **Goal.** Ship the atomic, set-based SQL the risky slices call. RPCs land **inert** (nothing calls them yet) so they can be deno-tested in isolation. Owner deploys the migration.
- **Scalability — the exact RPCs (all set-based, no per-slot loop, no load-all):**

  1. `apply_slot_delete_to_cycle(_cycle_id uuid, _slot_ids uuid[], _scope text /* 'future'|'all' */, _actor uuid) RETURNS TABLE(deleted_count int, protected_count int)` — `SECURITY INVOKER`. In ONE transaction: lock the cycle row; set-based guard (`SELECT slot_id FROM bookings WHERE slot_id = ANY(_slot_ids) AND status IN ('confirmed','pending')` → protected set), delete only the unprotected via `DELETE ... WHERE id = ANY(...)`, cascade proposals/claims, then a single set-based invoice recalc. Relies on **new index** `idx_bookings_slot_status ON bookings(slot_id) WHERE status IN ('confirmed','pending')` (the scale-lens flagged the missing one). Replaces the academy inline 500-chunk delete loop + trainer dialog loop.
  2. `apply_slot_edit_to_cycle(_cycle_id uuid, _slot_ids uuid[], _patch jsonb /* {start_offset,end_offset,trainer_id,location_id,max_participants,rating_system,min_rating,max_rating,is_public,price_per_session,split_payment,prices_include_vat,extra_costs} */, _actor uuid) RETURNS TABLE(updated_count int, invoices_resynced int)` — one set-based `UPDATE availability_slots SET ... WHERE id = ANY(_slot_ids)` (or `WHERE cyclus_id=_cycle_id` for whole-cycle), capacity-shrink guard via set-based join to current occupancy, then invoice resync **inside the same transaction**. Relies on `idx_availability_slots_cyclus` (exists).
  3. `update_cycle_pricing(...)` — **extend** the existing RPC (cycles.ts ~2060; migration 20260614120000) to also recalc overlapping invoices in-transaction and `RETURNS TABLE(updated_slots int, updated_invoices int)`. Removes the separate client `syncInvoicesAfterPriceChange` round-trip.
  4. `get_cyclus_groups_paginated(_academy_id uuid, _trainer_id uuid DEFAULT NULL, _limit int DEFAULT 50, _keyset_cursor jsonb DEFAULT NULL) RETURNS TABLE(group_key text, cyclus_id uuid, trainer_id uuid, trainer_name text, cyclus_name text, sessions int, player_count int, max_booked int, price_per_session numeric, is_public bool, payment_status_summary text, first_slot_id uuid)` — `LANGUAGE sql STABLE`. **SQL-side aggregation** (GROUP BY cyclus_id, trainer_id) with **keyset pagination** (not OFFSET). Replaces `AcademyCyclusOverview` loading all 10k slots + building ~100 Maps + ~10k Sets client-side. Relies on **new composite index** `idx_availability_slots_academy_trainer_cyclus`.
  5. `count_cycles_intakes(_cycle_ids uuid[]) RETURNS TABLE(cycle_id uuid, n int)` — one `GROUP BY` instead of the unbounded `intake_requests` scan in `getCyclesWithCounts` (cycles.ts 323-326) and the second scan in `listRegistrationCycles` (registrations.ts 116-119).
- **Reusability.** Every RPC takes `_actor`/owner params, not a role — academy and trainer call the identical function. RLS (`SECURITY INVOKER`) enforces ownership per-role.
- **Tests.** Characterization (from F1 goldens) asserts these RPCs reproduce current cascade outputs. After: deno RPC tests per function — delete-protected-vs-unprotected, edit capacity-shrink reject, pricing returns sync counts, keyset pagination stable under insert, intake-count GROUP BY. ~14 deno/integration tests. **Scale assertions:** keyset query plan uses the index (no seq scan), no client iteration over 10k.
- **Risk.** MED (new money-touching SQL, but inert). **Adversarial review mandatory.** **Owner deploys** the migration (RPCs + 3 new indexes) — frontend auto-deploys via Vercel but DB migrations do NOT (per MEMORY: owner applies manually).

### Foundation F3 — Shared-component skeletons (gates 6,7,3,4)
- **Goal.** Create the neutral, props-injected shells the role pages will adopt — inert, no behavior change yet.
- **Deliverables (all neutral folders, role-isolation-guardrail compliant — zero `components/{trainer,academy,club}` imports):**
  - `components/slots/DeleteSlotDialog.tsx` — **moved** from `components/trainer/DeleteSlotDialog.tsx` (618 lines), props: `{open, onOpenChange, slot, ownerType, onSlotDeleted, onError}`. The lift burns down FRONTEND_ARCHITECTURE debt #1 (academy importing trainer dialog).
  - `components/slots/SlotEditDialog.tsx` — new shell, props-injected role diffs: `{slot, ownerType, trainerList, locationList, canEditTrainer, canEditPrice, canApplyToCyclus, onSave}`. Trainer passes `canEditTrainer=false` (always current user); academy passes the trainer list. `canEditPrice`/`canApplyToCyclus` derive from `!!slot.cyclus_id` (the depth flips in 8b).
  - Thin `components/registrations/` index re-exporting the shared `CycleForm` wiring used by both create + edit, so Slices 3/4 have a stable import surface.
- **Scalability.** Components never fetch all slots; they receive a single `slot` + injected lists, and apply-to-cycle delegates to the F2 RPCs.
- **Reusability.** This *is* the reuse foundation. **Trainer parity ADDED:** the trainer side gets the same shared edit/delete dialog as academy (today they diverge).
- **Tests.** Characterization: render both old trainer dialog and new shared one against the same fixture → identical output (proves the lift is behavior-preserving). After: RTL component tests for both dialogs under `ownerType='trainer'` and `'academy'`. ~6 tests.
- **Risk.** LOW-MED (move + prop-plumb, no logic change). Light adversarial review on the DeleteSlotDialog move (it touches money paths). No deploy (frontend only).

### Slice 1 — `registrations` write API (lib only)
- **Goal.** `src/lib/registrations.ts`: add `createRegistration`, `updateRegistration`, `updateRegistrationSettings`, inverse mapper `cycleToRegistration`. Export the FORM-ONLY allowlist constant. Nothing calls them yet.
- **Scalability.** Single-row writes keyed by id. N/A at scale.
- **Reusability.** Pure lib; both roles' future write paths consume it. Guardrail-neutral (`lib/`).
- **Tests.** Characterization (F1's `registrations.golden` + `settingsSplit.golden`) locks the allowlist filter and round-trip `cycleToRegistration(registrationToCycle(reg)) ≈ reg`. After: ~8 unit (form-only filter, training-key rejection, null-safety, inverse mapper). ~10 tests.
- **Risk.** LOW (additive, mocked). No adversarial review. No deploy.

### Slice 2 — Club read-only (pure deletion)
- **Goal.** Remove club create/edit: `DomainRouter.tsx` (club create/edit routes ~327-328), `ClubCycles.tsx` (drop create/edit/`onEdit`/`onDuplicate`), `ClubCalendar.tsx` (drop Add-Slot), retire `ClubAddSlotDialog` + `ClubBulkCreateSheet`. Keep `ClubSlotDetailSheet` view-only.
- **Scalability.** Removes code; club views already paginate/read-only. Neutral.
- **Reusability.** Removes a role-isolation debt (club dialogs duplicating trainer logic).
- **Tests.** After: 2 unit (route removal), 3 component (DomainRouter has no club create route, ClubCycles has no create button, ClubCalendar has no Add-Slot). ~5 tests.
- **Risk.** LOW, pure UI/routing. No adversarial review. No deploy. Owner confirm scope (see §5).

### Slice 3 — Registration create flow → new API
- **Goal.** `CycleFormPage.tsx` new-mode + `CycleForm.tsx` create branch call `createRegistration`. Per the original §3 Option A: create BOTH a backing `cycles` row (`type='cyclus'`, training-only settings) + the `registrations` row atomically.
- **Scalability.** Creating one cycle + one registration. The atomicity mechanism is the open question (client two-insert vs `create_registration_with_cycle` RPC — see §5); recommend the RPC for atomicity since it touches the proposal FK invariant. No slot loops.
- **Reusability.** Goes through the shared `CycleForm`/`CycleFormPage` (already neutral) + the F3 `components/registrations` surface. Both academy and trainer create through the same path.
- **Tests.** Characterization: F1 create-golden (both inserts or neither). After: ~5 unit (two-insert split, training-key placement), 1 component (CycleFormPage new-mode), 2 RPC (atomic create, rollback on failure). ~8 tests.
- **Risk.** MEDIUM (touches proposal machinery). **Adversarial review mandatory.** Owner deploy only if the RPC variant is chosen.

### Slice 4a — Registration edit READ-resolve (no write change yet)
- **Goal.** `CycleForm.tsx` (load init ~107-168), `CycleFormPage.tsx` (load), `AcademyCycleDetail.tsx` (form-config init ~214-220): when editing, resolve via `getRegistration(source_cycle_id)` and **read** form config from `registrations.settings` if a row exists, else fall back to `cycles.settings` (unflipped, backward-compat). Writes still go through the Slice-0 guard (disabled).
- **Scalability.** One indexed `getRegistration`. No slot access.
- **Reusability.** Shared `CycleForm` load path serves both roles; academy detail reads via the same resolver.
- **Tests.** Characterization: F1 `settingsSplit.golden` proves read-merge (registrations form keys + cycles training keys) is correct. After: ~6 unit (direct-id vs source_cycle_id resolve, flipped-prefers-registrations, unflipped-falls-back), 2 component (CycleForm load, AcademyCycleDetail display). ~8 tests.
- **Risk.** MEDIUM (read-only divergence-adjacent). Adversarial review recommended (it's the setup for 4b). No deploy.

### Slice 4b — Registration edit WRITE-switch (CLOSES THE DIVERGENCE)
- **Goal.** Flip `CycleForm.onSubmit` (~526-637): if a registration exists, write form-only keys via `updateRegistration`, keep training keys on `updateCycle`. Remove the Slice-0 disable guard. This is the change the whole phase exists for — admin now writes where the live public form reads.
- **Scalability.** Two single-row writes (registration + cycle), allowlist-filtered. No slot loops.
- **Reusability.** Shared `CycleForm`; both roles write through the same split. (Trainer registration-detail page remains out of scope per original §6 — but the trainer *edit* path now correctly writes registrations too.)
- **Tests.** Characterization: F1 `registrations.golden` + `settingsSplit.golden` are the contract; the write must match them exactly. After: ~4 unit (form-keys→registrations, training-keys→cycle, no cross-leak), 2 component (flipped cycle save, unflipped fallback), 2 RPC/integration (update idempotency, public-form-read-sees-the-write). ~8 tests. **Proof of no-break:** the golden settings-split snapshot from F1 is unchanged.
- **Risk.** MED-HIGH (touches what the live public form reads). **Adversarial review mandatory.** No deploy (uses existing `registrations` RLS from migration 20260628100000).

### Slice 5 — Canonical routing + vocab cleanup (UI-safe)
- **Goal.** `DomainRouter.tsx` (academy ~336-368, trainer ~252-286): finalize `/app/{role}/registrations` (form) + `/app/{role}/cycles/:id` (training); add a `/app/trainer/registrations` alias for parity; keep `/academy/cycles`→`/registrations` redirect so distributed links/QR survive. Slot vocab rename deferred (DB stays `availability_slots`).
- **Scalability.** Routing only. Neutral.
- **Reusability.** Adds trainer routing parity with academy.
- **Tests.** After: 3 unit (redirect old→new), 2 component (DomainRouter rewire). ~5 tests.
- **Risk.** LOW-MED. No adversarial review. No deploy. Owner decides vocab depth (see §5).

### Slice 6 — Shared slot DELETE adoption (transactional apply-to-cycle)
- **Goal.** Rewire `TrainerSlotDetail.tsx` (~delete path) + `AcademySlotDetail.tsx` (replace inline delete ~517-588) onto F3's `components/slots/DeleteSlotDialog`, whose apply-to-cycle now calls F2's `apply_slot_delete_to_cycle` RPC instead of any client loop.
- **Scalability.** Delete is one set-based RPC (no 500-chunk client loop, no per-slot booking check). Guard + cascade + invoice recalc in one transaction, using `idx_bookings_slot_status`.
- **Reusability.** One neutral dialog for both roles; academy stops importing the trainer component (debt burned down). `filterDeletableSlotIds`/`slotDeleteGuard.ts` stay shared.
- **Tests.** Characterization: F1 `slotDeleteCascade.golden` (booked→protected, unbooked→deleted, invoice cleanup) must reproduce exactly through the new RPC. After: 2 unit (guard wrapper), 2 component (dialog both roles), 3 integration/RPC (delete unbooked, reject booked, transactional rollback). ~7 tests.
- **Risk.** MED-HIGH (money + cascade). **Adversarial review mandatory.** **Owner deploys** F2 migration (already shipped if F2 deployed) — verify before adoption.

### Slice 7a — Shared slot EDIT adoption (behavior-preserving)
- **Goal.** Replace the three divergent editors (`TrainerSlotDetail.tsx` ~220-316, `AcademySlotDetail.tsx` ~379-478, plus any club remnant) with F3's `components/slots/SlotEditDialog`, **preserving exact current behavior** (including the academy cyclus-price skip). No RPC yet — still the current client writes, just unified.
- **Scalability.** Single-slot edit unchanged; the *apply-to-cycle* loop is NOT yet replaced (that's 7b). This slice only unifies the UI.
- **Reusability.** One neutral dialog, props-injected (`canEditTrainer`, `canEditPrice`, `canApplyToCyclus`). **Trainer parity:** identical edit UX to academy. Guardrail-compliant.
- **Tests.** Characterization: F1 `slotEditCascade.golden` proves the unified dialog produces byte-identical writes to the three old editors (including the price-skip quirk). After: 3 component (dialog, trainer page, academy page), 4 unit (capacity-shrink validation, delta compute, field gating by prop). ~7 tests.
- **Risk.** MED (UI unification, behavior frozen). Adversarial review recommended. No deploy.

### Slice 7b — Slot EDIT transactional apply-to-cycle (RPC)
- **Goal.** Point `SlotEditDialog`'s apply-to-cycle at F2's `apply_slot_edit_to_cycle`; remove the non-transactional per-slot client loop in both role pages.
- **Scalability.** One set-based `UPDATE ... WHERE id = ANY(...)` + in-transaction invoice resync. No client loop. 10k slots = one RPC call.
- **Reusability.** Both roles' apply-to-cycle share the RPC.
- **Tests.** Characterization: the F1 edit-cascade golden, now asserted through the RPC, must equal 7a's output for the non-cycle-price fields. After: 4 RPC/integration (atomic time/trainer edit, price edit + invoice resync, capacity-shrink reject, split-divisor stable M-19). ~5 tests.
- **Risk.** HIGH (money + atomicity). **Adversarial review mandatory.** **Owner deploys** (F2 RPC) — confirm deployed.

### Slice 8a — Slot = price source: route bulk-price through atomic RPC (kill the client loop)
- **Goal.** `AcademyCyclusOverview.tsx` (~709-742): replace the 500-chunk client `update` loop + separate `syncInvoicesAfterPriceChange` with the extended `update_cycle_pricing` RPC (F2 #3). Repaginate the cycle group view onto `get_cyclus_groups_paginated` (F2 #4) so the page no longer loads all 10k slots / aggregates client-side.
- **Scalability.** This is the single biggest scale fix: bulk price = one atomic RPC (was 20+20 non-atomic round-trips at 10k); group list = SQL-side aggregation + keyset pagination (was load-all + ~100 Maps + ~10k Sets client-side). Add row virtualization or page-of-50 to the group render (the lens flagged 500+ rows un-virtualized).
- **Reusability.** Shared `CyclePricingCard` (already neutral); the paginated group RPC is role-agnostic (academy now; trainer can adopt later).
- **Tests.** Characterization: F1 pricing golden + a bulk-price-edit golden (N slots → uniform update, invoices recalced, split unchanged) must reproduce through the RPC. After: 5 unit (RPC wrapper, split count, price precedence slot>cycle), 2 component (bulk-price UI, paginated group render), 3 integration (atomic update, invoice resync counts, keyset page stability). ~10 tests. **Scale proof:** assert the page issues O(1) paginated RPC calls, not a 10k load.
- **Risk.** HIGH (money + audit trail). **Adversarial review mandatory.** **Owner deploys** (F2 RPC + indexes).

### Slice 8b — Slot = price source DEPTH (derive cycle total + recompute split_count)
- **Goal.** (Owner-gated, see §5) Make `cycles.total_price` strictly derived from Σ slot prices everywhere; recompute `split_count` on every re-sync (`invoiceSync.ts` ~440-475); enable per-cyclus-slot price editing in `SlotEditDialog` by flipping `canEditPrice` for cyclus slots (closes the 7a-frozen skip). Column stays (per original §6).
- **Scalability.** Derivation is a SQL aggregate (`SUM(price_per_session)` over the cycle), not client iteration; split recompute is set-based in the RPC.
- **Reusability.** `SlotEditDialog` price field now enabled for cyclus slots in both roles.
- **Tests.** Characterization: lock current `total_price` read behavior, then prove the derived value matches for existing data. After: ~5 unit (derivation, split recompute M-19), 3 integration (per-slot override behavior, invoice line-item reads slot not cycle.total_price). ~8 tests.
- **Risk.** HIGH. **Adversarial review mandatory.** Owner deploy if it extends the RPC. **This slice is optional/deferrable** depending on the §5 depth answer.

---

## 3. THE FOUNDATIONS (explicit — these gate the risky slices)

| Foundation | Deliverable | Gates |
|---|---|---|
| **F1 harness** | `src/test/fixtures/factory.ts` (+ `makeCycleWith(10_000)`), `supabaseMock.ts`, 5 golden files locking pricing/settings-split/edit-cascade/delete-cascade/registrations-write | ALL refactor slices (1, 3, 4a/b, 6, 7a/b, 8a/b) |
| **F2 set-based RPCs** | `apply_slot_delete_to_cycle`, `apply_slot_edit_to_cycle`, extended `update_cycle_pricing` (returns sync counts), `get_cyclus_groups_paginated` (keyset), `count_cycles_intakes` (GROUP BY) + 3 new indexes (`idx_bookings_slot_status`, `idx_availability_slots_academy_trainer_cyclus`, composite cycle owner/status) | 6, 7b, 8a/b; also de-risks `getCyclesWithCounts`/`listRegistrationCycles` |
| **F3 shared skeletons** | `components/slots/DeleteSlotDialog` (lifted from trainer/), `components/slots/SlotEditDialog` (new, props-injected), `components/registrations/` index | 6, 7a, 3, 4a/b |

**Rule: no risky slice (6, 7a/b, 8a/b) starts until F1+F2+F3 are merged and F2's migration is owner-deployed and verified.**

---

## 4. SEQUENCE + risk classification

```
0 ─────────────────────────────────────────────► (ship first, UI-safe, no foundations needed)

F1 ──┐
F2 ──┼──► (foundations, parallelizable; F2 deploy = owner)
F3 ──┘
        │
        ├─► 1 ──┐
        ├─► 2   │   (1,2 parallel; 2 needs no foundation)
        │       │
        │       └─► 3 ──► 4a ──► 4b ──► 5
        │
        └─► 6 ──► 7a ──► 7b ──► 8a ──► 8b
                                   (8b owner-gated/optional)
```

**Dependency notes:** 6/7/8 need F2+F3; 3/4 need F1+F3 (+ Slice 1); 4b needs 4a; 7b needs 7a; 8a needs F2 #3+#4; 8b needs 8a.

**Pure-UI / safe (no adversarial review):** Slice 0, F1, Slice 2, Slice 5, Slice 7a (frozen behavior — light review).

**Money/data — adversarial review MANDATORY:** F2, Slice 3, Slice 4b (and 4a recommended), Slice 6, Slice 7b, Slice 8a, Slice 8b.

**Owner migration / edge-fn deploys required:** F2 (RPCs + 3 indexes — the big one), Slice 3 (if RPC create variant), Slice 6 / 7b / 8a / 8b (consume F2's deployed RPCs — verify deployment before adoption). Per MEMORY: frontend auto-deploys via Vercel; DB migrations do NOT — owner applies F2 manually and confirms before the consuming slices ship.

---

## 5. OPEN QUESTIONS for the owner

**Carried forward (unresolved in original):**
1. **Create-flow atomicity (Slice 3):** Option A (create both cycles+registrations) is confirmed by the FK-invariant argument — but **client-side two-insert vs a transactional `create_registration_with_cycle` RPC?** Recommendation: RPC (touches proposal FK).
2. **Routing vocab (Slice 5):** keep `/app/{role}/registrations` (form) + `/app/{role}/cycles/:id` (training)? Retire the `/academy/cycles`→`/registrations` redirect or keep for QR durability? Rename `/slot/:id`→`/session/:id` now or defer (DB stays `availability_slots`)?
3. **Slot=price depth (Slice 8b):** minimum (8a only — kill the bulk-price bypass + paginate) or full (8b — `cycles.total_price` strictly derived everywhere + recompute split_count + enable per-cyclus-slot price edit)? **This determines whether 8b ships.**
4. **Interim guard variant (Slice 0):** disable-the-fields (zero risk, recommended) or mirror-to-registration (needs Slice 1 first)?
5. **Club scope (Slice 2):** confirm clubs keep read-only `ClubCycles` + `ClubCalendar` + `ClubSlotDetailSheet`; delete only create/edit?

**NEW (surfaced by the lenses):**
6. **Cycle slot-view pagination UX (8a):** keyset-paginated pages of 50 vs row-virtualization (`react-window`) for the group list? The current page renders all groups un-virtualized; at 10k slots / 500+ groups this stutters. Which approach does the owner want — and is adding `react-window` as a dependency acceptable?
7. **10k-fixture approach (F1):** synthetic in-memory factory (fast, mock-based) for Vitest, plus optional Supabase-emulator-backed integration tests in CI for the F2 RPCs? The emulator catches real RPC/transaction bugs the mock can't, but adds CI cost. Want the emulator gate or mock-only?
8. **`apply_slot_edit_to_cycle` patch scope (F2 #2):** should the edit RPC's `_patch` support a *relative* time shift (start/end offsets, for "move the whole cycle 30 min later") in addition to absolute fields, or absolute-only for Phase 4?
9. **Trainer registration-detail parity (deferred):** original §6 keeps trainer with no registration-detail page. Phase 4 now gives trainer the shared slot edit/delete + create/edit write path — confirm the trainer *intake/proposal review* detail page stays out of scope, or schedule it as a Phase 5 follow-up?

---

**Files this revision is grounded in (absolute):** `/Users/tom/Cursor/padeltrainer/docs/PHASE4_PLAN.md`, `/Users/tom/Cursor/padeltrainer/src/lib/registrations.ts`, `/Users/tom/Cursor/padeltrainer/src/lib/cycles.ts` (updateCyclePricing ~2060-2081), `/Users/tom/Cursor/padeltrainer/src/lib/invoiceSync.ts` (syncInvoicesAfterPriceChange ~440-475), `/Users/tom/Cursor/padeltrainer/src/pages/academy/AcademyCyclusOverview.tsx` (bulk-price loop ~709-742), `/Users/tom/Cursor/padeltrainer/src/pages/academy/AcademySlotDetail.tsx` (inline delete ~517-588, edit ~379-478), `/Users/tom/Cursor/padeltrainer/src/pages/trainer/TrainerSlotDetail.tsx` (~220-316), `/Users/tom/Cursor/padeltrainer/src/components/trainer/DeleteSlotDialog.tsx`, `/Users/tom/Cursor/padeltrainer/src/lib/slotDeleteGuard.ts`. Migration convention: `supabase/migrations/YYYYMMDDHHMMSS_*.sql` (latest `20260628100100_registrations_dates.sql`); F2 lands as a new timestamped migration the owner deploys.