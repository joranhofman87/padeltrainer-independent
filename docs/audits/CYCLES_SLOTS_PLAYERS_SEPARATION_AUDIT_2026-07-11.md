# Architecture Audit — Cycles ⇄ Registrations ⇄ Slots ⇄ Players

**Date:** 2026-07-11
**Scope:** Is the `cycles` table's polymorphism (training *cyclus* vs sign-up *registration* vs one-off *event*) cleanly separated? Are training cycli fully disconnected from registration forms? Is the cycles⇄slots⇄players wiring internally consistent?
**Method:** Fresh-eyes, multi-agent. 6 mapping agents built an architecture map from source; 5 (of 7) adversarial finders hunted for defects; headline findings verified directly against code. Every claim below is anchored to `file:line`.
**Constraint honoured:** code + SQL migrations only — no memory, no prior audit docs, repo `docs/` treated as unverified claims.

> **Companion doc:** a separate session independently produced `docs/audits/ARCHITECTURE_AUDIT_2026-07-11.md` on the same day. This document was written independently and is not a merge of it. Where the two agree, treat it as convergent confirmation.

---

## 1. Verdict

### (a) Are cycles & registrations mixed up?
The **design is sound** — a deliberate two-table split (`cycles` = container, `registrations` = form overlay, migrations `20260628100000` + `20260630130000`), with money paths guarded by server-side type checks. But the split is **half-adopted**, and that gap produces real, reproducible mixing. The single deepest problem: `create_registration_with_cycle` mints its cycle shell as **`type='cyclus'`** ([registration_write_rpcs.sql:102-125](../../supabase/migrations/20260630130000_registration_write_rpcs.sql)), while ~12 surfaces still treat `type='cyclus'` as "plain training cycle." **The discriminator the codebase leans on is wrong for every registration created since the split.**

### (b) Are cycli fully disconnected from registration forms?
**No — the disconnection is by convention, not enforced by construction.** No DB constraint, FK, or trigger conditions any behaviour on `cycles.type`; the FKs into `cycles` (`intake_requests.cycle_id`, `availability_slots.cyclus_id`, `invoices.cycle_id`) carry no type condition ([map: schema, all-FKs fact]). Multiple confirmed paths cross the line in both directions (§3).

### (c) Is cycles⇄slots⇄players internally consistent?
**Write side: yes** — one `bookings` ledger, one write facade, atomic capacity-locked RPCs, trigger-maintained guest⇄profile linking. **Read side: no** — four different "who's in / how full" definitions, plus name/price/date drift between a cycle and its slots (§3, Theme 6–7).

---

## 2. What is genuinely solid (do not "fix")

- **The money layer's structural separation is provably sound** (dedicated money-path finder). Three idempotency keys live on three different columns — event `(cycle_id, registrant)`, rebook-single `(rebook_cyclus_id, registrant)`, rebook-group `(rebook_group_id)` — and **booking invoices provably keep `cycle_id` NULL** (`auto-create-invoice`'s insert has no `cycle_id`; the *only* insert that sets it is the event/registration minter). So a training-cyclus booking invoice and an event/registration invoice **cannot collide on a key**. The minter refuses to charge a `cyclus` ([event-registration-invoice.ts:109-111](../../supabase/functions/_shared/event-registration-invoice.ts)); `update_cycle_pricing` writes only slot columns, never the overlay price; the zombie-invoice sweep is scoped to rebook-tagged invoices. The one runtime money defect is Theme 12 (below), not a structural collision.
- **`bulk-rebook-cycle` single-source mode refuses non-`cyclus` sources** ([bulk-rebook-cycle/index.ts:277-281](../../supabase/functions/bulk-rebook-cycle/index.ts)); rebook invoices deliberately avoid `invoices.cycle_id` *because that column belongs to the event flow* ([20260705130000_rebook_single_invoice_dedup.sql:9-24](../../supabase/migrations/20260705130000_rebook_single_invoice_dedup.sql)).
- **Single write-ledger for players.** All seats flow through `bookings` via one facade (`src/lib/bookings.ts`) + atomic capacity-locked RPCs; guest⇄profile linking is trigger-maintained. **No intake→booking write leak** exists (the overview's intake merge is read-only); `merge_guest_players` keeps all four attachment ledgers in sync; the **guest cart** money path fails closed at the slot-tier level.
- **The rebook engine never collides with forms.** It identifies its own cycles by `settings->>rebook_payment_mode`, guarded by `uniq_rebook_cycle_key`; its re-run cleanup can't touch a manually-created registration.

---

## 3. Findings (ranked, deduplicated across finders)

Severity: **P0** data-loss/security · **P1** wrong money or wrong lifecycle reaching a user · **P2** structural mixing / drift · **P3** cosmetic-but-real.

### 🔴 P1 · Theme 1 — the `type='cyclus'` shell breaks registration editing & lifecycle
The registration RPC creates the shell **born `type='cyclus'`** with price/format on the overlay.
- **Editing a registration writes the wrong table.** Detail edit button → `/registrations/:sourceCycleId/edit` ([AcademyCycleDetail.tsx:645](../../src/pages/academy/AcademyCycleDetail.tsx)); `CycleFormPage` loads `getCycle` (the shell, `type='cyclus'`) → `writeTarget='cycle'` (**verified** [CycleFormPage.tsx:255-262](../../src/pages/CycleFormPage.tsx)) → `updateCycle` writes only the cycles row; `update_registration_with_cycle` is **unreachable**. Result: price/format/status edits save in admin UI but **players keep paying the stale overlay values**.
- **Closing a registration doesn't close its form.** Open/close toggle writes `cycles.status` only ([AcademyCycleDetail.tsx:391-401](../../src/pages/academy/AcademyCycleDetail.tsx)); the public form obeys `registrations.status`. Close → sign-ups + Mollie payments keep flowing.

### 🔴 P1 · Theme 2 — any open cyclus / rebook round is a working public sign-up form
`cycles_public` filters `status='open'` with **no type filter** ([20260706130300_p2_1_cycles_public_view.sql:21-47](../../supabase/migrations/20260706130300_p2_1_cycles_public_view.sql)); `/register/:id` falls back to it with **no type guard** ([CycleRegistration.tsx:73-83](../../src/pages/CycleRegistration.tsx)). Slot-generator cycli are `status='open'` ([slotGenerator.ts:164-165](../../src/lib/slotGenerator.ts)); rebook rounds are flipped to `'open'` at commit and never leave it (archive is settings-only). `submit-guest-intake` inserts intakes with **zero type/status checks** + sends a "registration confirmed" email ([submit-guest-intake/index.ts:348-373,528-542](../../supabase/functions/submit-guest-intake/index.ts)). Also: `cycles_public` leaks **all ~17 `rebook_*` settings** (invite text, priority-list UUIDs) to anon callers (strips only 2 keys).

### 🔴 P1 · Theme 3 — `intake_requests.status` schema drift (prod ≠ migrations)
The only committed CHECK is `('new','proposed','confirmed','rejected','waitlist')` ([20260123104639…sql:35](../../supabase/migrations/20260123104639_a8603885-c6cd-43bb-85e9-e4e29f584d23.sql)); no migration widens it, yet `finalize_cycle_proposals` writes `'booked'` ([20260701120000…sql:44-51](../../supabase/migrations/20260701120000_finalize_cycle_proposals_rpc.sql)) and readers filter on it. **The constraint was altered outside migrations** → a DB rebuilt from migrations (CI, PGlite, restore) fails the approve/finalize flow. (Corollary: the Phase-2 split RPCs are deployed in prod → Theme 1 is *live*, not latent.)

### 🔴 P1 · Theme 4 — editing / duplicating clobbers rebook rounds
- Trainer **player-detail links every booked cyclus** to the registration editor ([trainerCyclusPricingRoute.ts:15-21](../../src/lib/trainerCyclusPricingRoute.ts), [TrainerPlayerDetail.tsx:283](../../src/pages/trainer/TrainerPlayerDetail.tsx)); saving rebuilds `settings` from scratch (no spread — [CycleForm.tsx:556-598](../../src/components/cycles/CycleForm.tsx)) → **wipes all `rebook_*` keys + `generated_by` + `excluded_dates`**, nulls `cycles.price_per_session`; the round vanishes from the hub (filters on the deleted marker) and the upfront-skip in the billing cron is lost.
- **`BulkCopySlotsWizard`** loads cycles unfiltered ([BulkCopySlotsWizard.tsx:64-69](../../src/components/cycles/BulkCopySlotsWizard.tsx)), copies `type: sourceCycle.type` + `status:'open'` + injects `rebook_payment_mode` (:163-177) → duplicating a registration mints a **live public form that is also a rebook round**; cross-pollinates the engine's identity marker onto any copy.
- **`update_registration_with_cycle`** (SECURITY DEFINER, granted to all authenticated) has **no source-type guard** ([20260630130000…sql:165-218](../../supabase/migrations/20260630130000_registration_write_rpcs.sql)) — pointed at a rebook round it overwrites the cycle + mints an overlay. Only a client-side ternary prevents it.

### 🟠 P2 · Theme 5 — destructive / mutating ops with no type guard
- **Academy calendar bulk-delete** treats registration rows (relabeled `type='cyclus'` by the overview RPC) as training groups; `handleBulkDelete` → `deleteCycle` CASCADE-deletes **every sign-up on a legacy registration**; the "has bookings" skip never counts intakes ([AcademyCyclusOverview.tsx:860-906](../../src/pages/academy/AcademyCyclusOverview.tsx)).
- **`generate-proposals`** deletes+regenerates slots on any cycle type (owner-auth only, [generate-proposals/index.ts:403-430,541-564](../../supabase/functions/generate-proposals/index.ts)) → run on a rebook round it **cascade-deletes pending priority claims** (`slot_priority_claims.slot_id ON DELETE CASCADE`).
- **Cohort-mode `bulk-rebook`** gathers slots by academy+location+time with no type join ([bulk-rebook-cycle/index.ts:400-406](../../supabase/functions/bulk-rebook-cycle/index.ts)) — a finalized registration's slots get swept into a new round (the type guard exists only in single-source mode).
- **Bulk visibility / price** actions on the overview are ungated (only the booking-mode neighbour is gated) → publishing a registration's private workflow slots (double-sell) or rewriting its server-trusted form price ([AcademyCyclusOverview.tsx:832-853,940-957](../../src/pages/academy/AcademyCyclusOverview.tsx)).
- **`TrainerScheduleOverview`** cycle-edit extends/reprices/split-toggles registration & event cycles with no type gate — the same cycle its own detail view refuses ([TrainerScheduleOverview.tsx:442-506,624-694,733-745](../../src/pages/TrainerScheduleOverview.tsx)).

### 🟠 P2 · Theme 6 — cycles⇄slots drift (name / price / date)
- **Name:** three writers, none syncs both sides — cyclus rename updates future slots' `cyclus_name` only; registration rename updates `cycles.name` only; `generate-proposals` stamps no `cyclus_name`. Different surfaces show different names ([20260629140000…sql:150](../../supabase/migrations/20260629140000_phase4_f2_apply_slot_edit.sql), [CycleDetailView.tsx:181-184](../../src/components/cycles/CycleDetailView.tsx)).
- **Price:** overview & pricing card display `cycles.price_per_session` while booking charges the *slot* column; opening + saving the pricing card pushes the stale cycle value onto slots **and rewrites unpaid invoices** ([get_academy_cyclus_groups.sql:173](../../supabase/migrations/20260630140000_get_academy_cyclus_groups.sql), [CycleDetailView.tsx:192-197,495-511](../../src/components/cycles/CycleDetailView.tsx)).
- **Date:** `cycles.start_date` is never synced when first sessions move/delete, yet the commitment-invoice cron uses it as the billing due-gate **and** the split-divisor cutoff → per-head overcharge + billing fires before the round starts ([generate-cycle-commitment-invoices/index.ts:70,111-118](../../supabase/functions/generate-cycle-commitment-invoices/index.ts)).

### 🟠 P2 · Theme 7 — four definitions of "who's in / how full"
| Surface | Occupancy definition | Source |
|---|---|---|
| DB capacity truth (booking RPCs, public occupancy) | confirmed+pending+pending_approval **+ live payment holds** | [20260703140000…sql:83-96] |
| Cycle-detail roster / slot detail | confirmed+pending+pending_approval (no holds) | [lessons.ts:19](../../src/lib/lessons.ts) |
| Agenda + academy calendar | confirmed+pending only | [agendaSlots.ts:62-74](../../src/lib/agendaSlots.ts) |
| Players-overview list | confirmed/**completed** only | [get_players_overview] |

Plus the overview **merges intake names** into cyclus rosters ([get_academy_cyclus_groups.sql:138-199](../../supabase/migrations/20260630140000_get_academy_cyclus_groups.sql)) while cycle-detail counts bookings only; and the detail roster **silently drops name-less members while still counting them** ([cycleDetail.ts:121-128](../../src/lib/cycleDetail.ts)). This is the mechanical root of the "weird cases."

### 🟡 P3
- `DeleteCycleDialog` SET-NULLs live booked slots (keep rendering with stale name, unreachable by any cycle tool); warning mentions only intakes ([DeleteCycleDialog.tsx:62-87](../../src/components/cycles/DeleteCycleDialog.tsx)).
- SEO prerender (`render-page/db-facts.ts:379-393`) advertises training cycli + draft rebook rounds as public "upcoming programs" with Course JSON-LD (service-role read, no filter).
- Intake add-dialog offers every cycle/type/status as an intake target ([AddIntakeRequestDialog.tsx:343-347](../../src/components/cycles/AddIntakeRequestDialog.tsx)).
- `enrollment_deadline` = "waitlist" to the form but ignored by the payment path → waitlisted registrants charged full price immediately.
- `Boekbaarheid` treats RLS-hidden (closed/draft) academy registration cycles as orphan cycli and stamps booking flags on their slots ([TrainerScheduleOverview.tsx:365-371](../../src/pages/TrainerScheduleOverview.tsx)).

### 🟠 P2 · Theme 12 — `finalize-proposals` merges training bookings into an unpaid registration invoice → slot-price re-pricing
The one real money defect (the rest of the money layer is sound — see §2). Chain: a registration sign-up invoice is minted with `booking_ids: []`, `cycle_id=<shell>`, `total` from the **overlay price** ([event-registration-invoice.ts:251-270](../../supabase/functions/_shared/event-registration-invoice.ts)). On cohort finalize, `finalize-proposals` merges the new training `booking_ids` into that invoice for **any status except `cancelled`** ([finalize-proposals/index.ts:204-212](../../supabase/functions/finalize-proposals/index.ts)), marking bookings paid only if already paid. The invoice is now indistinguishable from a booking invoice to the sync engine — a later slot-price edit or booking cancel matches it via `booking_ids` overlap ([invoiceSync.ts:509-544](../../src/lib/invoiceSync.ts)) and **rebuilds `total` purely from `availability_slots.price_per_session`**. **Failure:** registrant quoted a €50 registration fee (unpaid), academy finalizes then edits slot pricing → the `sent` invoice is silently overwritten to the slot-based training total (e.g. 12×€22), and the registrant pays an amount that was never the registration price. Both preconditions are routine → **escalates to P1** in academies that finalize before payment clears. Fix: don't overload `booking_ids` on an overlay-priced (`cycle_id IS NOT NULL`) invoice, or have the sync engine skip invoices with `cycle_id`/`registration_id`.

### 🟡 P3 (money) — cron type-blindness (latent) + same-profile over-dedup (under-billing)
- **Commitment cron** scans all `status IN ('open','closed')` cycles with no type/owner filter ([generate-cycle-commitment-invoices/index.ts:52-56](../../supabase/functions/generate-cycle-commitment-invoices/index.ts)); saved *incidentally* (bills only bookings with a `claimed` priority claim — a rebook-only construct) not by a type check. Not exploitable today; the safety rests on data shape, not an explicit guard.
- **`uniq_live_event_invoice_per_registrant`** keys on `(cycle_id, COALESCE(player_id,guest_player_id))` ([20260621110000_event_invoice_dedup.sql:14-17](../../supabase/migrations/20260621110000_event_invoice_dedup.sql)); the logged-in path always mints with `player_id=profile.id`, so a **parent registering two children under their own account** gets only one payable invoice — the second child's charge silently collapses → **academy under-collects**. (Guest path escapes it: distinct `guest_player_id`.)

### 🔴 P1 · Theme 8 — staff roster-add capacity guard is blind to live guest payment-holds (overbook)
The DB trigger `enforce_booking_slot_tier` on every staff/academy booking insert counts `status IN ('confirmed','pending','pending_approval')` **only** — it does **not** count live `payment_pending` holds ([20260702140000_capacity_count_allowlist.sql:63-67](../../supabase/migrations/20260702140000_capacity_count_allowlist.sql)); the JS pre-check in cycle-roster add matches ([cycleRoster.ts:121-125,156-160](../../src/lib/cycleRoster.ts)). But the **public** occupancy read and the pay-first RPCs *do* count live holds ([get_public_slot_occupancy 20260706140000:27-30](../../supabase/migrations/20260706140000_public_slot_occupancy_rpc.sql), [book_guest_slot_for_payment 20260704190000:110-116](../../supabase/migrations/20260704190000_book_guest_slot_for_payment.sql)). **Failure:** a public slot with N in-flight guest checkouts reaching `max_participants` shows **full** to the public but **0 taken** to the staff trigger → the roster-add succeeds and the slot is **oversold** once holds convert. A money-path overbook between two views of the same session.

### 🔴 P1 · Theme 9 — generic roster swap/cancel strands `slot_priority_claims` (rebook-manage vs cycle-detail disagree)
`swapPlayerInCycle` re-points `bookings.guest_player_id` in place and cancels via `cancelBookingsAndSync` ([cycleRoster.ts:290-317](../../src/lib/cycleRoster.ts)); **neither `cycleRoster.ts` nor `bookings.ts` touches `slot_priority_claims`.** Rebook-manage derives "who rebooked / who paid" *exclusively* from claims ([rebookManage.ts:401-411](../../src/lib/rebookManage.ts)). **Failure:** on a rebooked cycle, a staff swap A→B (or cancel A) via cycle-detail → cycle-detail shows **B**, rebook-manage still shows **A** as `claimed`/rebooked/paid, and A's `claim.booking_id` dangles at a cancelled/foreign booking. The dedicated `freePlayerRebookSeat` *does* sync both ([rebookManage.ts:772-777](../../src/lib/rebookManage.ts)) — so only the **generic** roster ops strand claims. *(Independently confirmed by two finder passes.)*

### 🟠 P2 · Theme 7 (reinforced) — the four occupancy definitions, precisely
The players-roster finder pinned the exact divergent predicates and their user-visible failures:
- `pending_approval` seat → **open on the agenda calendar** ([agendaSlots.ts:62-64](../../src/lib/agendaSlots.ts)) but **occupied** to the trigger + cycle-detail → staff add from calendar hits `slot_full`.
- `pending`-only player → **in cycle-detail roster** but **absent from players-overview list** ([get_players_overview.sql:129](../../supabase/migrations/20260611160001_get_players_overview.sql) requires confirmed/completed).
- `completed`-only player → **in players list + passes `has_active_cyclus`** but **absent from cycle-detail** (completed ∉ capacity set).
- Cyclus-overview roster = bookings **UNION intake names, deduped by NAME**; cycle-detail = bookings-only, **deduped by id** → two humans named "Jan de Vries" = 1 on overview, 2 on detail; an intake-only cycle shows `player_count≥1` on overview, `0` on detail.

### 🟡 P3 (players) — duplicate-identity double-seat + anon/authed count drift
- **M-17 exemption double-seat:** `uniq_active_booking_per_slot_player` is `WHERE player_id IS NOT NULL AND guest_player_id IS NULL` ([20260612140000:49-52](../../supabase/migrations/20260612140000_m17_unique_active_bookings.sql)) — a linked-guest row (both ids set) is exempt, so the *same human* can hold a pure-profile booking AND a linked-guest booking on one slot; `bookedCount` counts 2, roster dedups to 1 ([cycleDetail.ts:115,121](../../src/lib/cycleDetail.ts)) → badge 2/4 vs 1 name, silently over-occupied.
- The public-availability **deploy-fallback** direct read counts `('pending','confirmed')` only ([usePublicAvailability.ts:141-145](../../src/hooks/usePublicAvailability.ts)) — drops holds + `pending_approval`; anon (RPC) vs authed (fallback) can disagree while the RPC is briefly undeployed.

**Players-roster clean areas (verified):** no intake→booking write leak (the overview's intake merge is read-only); `merge_guest_players` is internally consistent (dedups + repoints bookings/claims/intakes/metadata together); the pay-first/public-read cluster agrees with itself (`get_public_slot_occupancy` == the booking RPCs' predicate) — every divergence is between that cluster and the **academy-facing** surfaces.

<!-- PLAYERS_FINDER_SECTION_DONE -->

### 🔴 P1 · Theme 10 — account-deletion wipes cross-type cycles & orphans their slots (untouched subsystem)
`_shared/delete-user-data.ts` (called by both admin `delete-user` and self-service `request-account-deletion`) deletes cycles by owner with **zero type awareness** — registration/event/rebook-round cycles are wiped identically to training cycli. The academy & club branches ([:76-80,:108-112](../../supabase/functions/_shared/delete-user-data.ts)) delete only `intake_requests` + `cycles` with **bare awaits that swallow FK errors** (the trainer branch wraps `runDelete`), and **never delete the cycles' `availability_slots`** → those slots survive `cyclus_id` SET NULL, leaving **bookings and `slot_priority_claims` dangling on orphaned slots**. Not covered by Theme 5's list. Production data-integrity risk; warrants its own fix round.

### 🟠 P2 · Theme 11 — analytics revenue is blind to registration/event/rebook money
`dashboard_analytics` computes revenue **only from `bookings`** (`SUM(COALESCE(payment_amount, price_per_session))` over `bookings b` — [dashboard_analytics.sql:41-42,125-126]). Registration/event cycles route income through **`invoices`**, not bookings, so the trainer/academy dashboard revenue **silently omits all registration + event + rebook-invoice income**. The type-split created a money path the analytics RPC never learned about.

### Refinements the critic established (corrections to earlier themes)
- **Theme 3 understated:** it's not one undeclared status but at least **two** — `finalize-proposals` writes `'booked'` and `send-schedule-notifications` writes `'notified'` ([send-schedule-notifications/index.ts:113,180](../../supabase/functions/send-schedule-notifications/index.ts)), plus `'pending'` is queried in the overview RPC. All three are outside the committed CHECK → prod drifted for multiple values, codebase-wide.
- **Theme 1 precision (split vs legacy):** closing via the toggle leaves `registrations.status='open'`. For a **split** registration the public `/register` form reads the *overlay* status (via `registrationToCycle`) so it **stays open** — the finder's P1 holds; for a **legacy** (no-overlay) registration the form falls back to the cycle status and *does* close. Either way, overlay-reading consumers (`getRegistration`) see stale data. (Independent analyses split on this; the split/legacy distinction reconciles them — but confirm against a real split row.)

### Structural gaps the critic flagged (not bugs — open guarantees)
- **`availability_slots.cyclus_id → cycles` is `ON DELETE SET NULL` AND `NOT VALID`** ([20260630120000_phase4_C_cyclus_id_fk.sql:45-49,57-81](../../supabase/migrations/20260630120000_phase4_C_cyclus_id_fk.sql)) — validation is a manual owner step the migration says must not be automated. So the FK doesn't cover pre-existing rows, and every cross-type cycle delete **orphans slots rather than cascading**. This structurally underpins Themes 5, 6, 10.
- **No index on `cycles.type`** — the polymorphic discriminator that hot reads (overview, `cycles_public`) filter by has no index (only `owner`, `status`, `location_id`). Likely fine at current scale; unassessed.
- **adequate:** the **guest cart** money path — `create-guest-cart-payment` gates at the slot-tier level (`is_public` + `resolveSlotTier` + `public_release_status`), the money-path analog of the `/register` leak but **fails closed**. No new gap.

---

## 4. Root cause & remediation plan

**One root cause:** the registration/cycle split is unfinished. The overlay exists, but (1) legacy rows were never backfilled — the cutover lives only in `docs/PHASE2_STEP3_CUTOVER.sql`, never a real migration — and (2) ~12 consumers still discriminate on the now-ambiguous `cycles.type`.

**Proportionate cure, in order (each batch is independently shippable):**
1. **The wrong-money P1/P2s** — Theme 12 (finalize-proposals `booking_ids` overload → sync skips `cycle_id`/`registration_id` invoices), Theme 8 (staff capacity guard must count live holds), Theme 1 (registration edit routing + status toggle). These actively mis-charge/oversell.
2. **Confirm & codify the prod schema** (Theme 3: `intake_requests.status` CHECK, including `'booked'` + `'notified'`) in a committed migration.
3. **Guard the destructive/edit writes by type** server-side (Themes 4/5/10: `generate-proposals`, `update_registration_with_cycle`, cohort rebook, bulk delete/visibility/price, `TrainerScheduleOverview` edit, **`delete-user-data` slot cleanup**). RLS scopes by owner but never by type; validate the `cyclus_id` FK.
4. **Sync the ledgers on generic roster ops** (Theme 9: make `swapPlayerInCycle`/`cancelPlayerBookingsInCycle` sync `slot_priority_claims` the way `freePlayerRebookSeat` already does).
5. **One shared `isRegistrationForm()` resolver** — the built-but-unused [`classifyCyclusId`](../../src/lib/cycleIntegrity.ts) is a starting point — replacing the ~12 per-surface reimplementations, plus **one canonical occupancy predicate** (hold-aware `confirmed/pending/pending_approval + live payment_pending`) routed through the staff-add trigger, agenda, players-overview, cyclus-overview, and cycle-detail (Themes 6/7).
6. **Analytics** — extend `dashboard_analytics` to include registration/event/rebook `invoices` income (Theme 11).

After step 3, `cycles.type` stops being load-bearing and the separation is enforced-by-construction.

## 5. Prod checks required (cannot be answered from code)
- **`\d intake_requests`** — does the `status` CHECK include `'booked'` **and `'notified'`**? (Confirms Theme 3 + that split RPCs are deployed → Themes 1/12 live vs latent.)
- **`select count(*) from cycles c join registrations r on r.source_cycle_id=c.id where c.type='cyclus'`** — registrations affected by the edit-routing P1.
- **`select count(*) from cycles where type='registration'`** — how many legacy (un-split) forms remain.
- **Is `availability_slots_cyclus_id_fkey` VALIDATED?** (`select convalidated from pg_constraint where conname='availability_slots_cyclus_id_fkey'`) — governs Themes 5/6/10 orphaning.

## 6. Coverage
- **Mapped (from source):** schema+constraints · type taxonomy · registration/event flow · training-cyclus flow · UI surfaces+queries · player-attachment map.
- **Finder coverage (all 7 + critic complete):** reg→cyclus · cyclus→reg · lifecycle/status · slots-integrity · write-time type guards · **money-path** · **players-roster** · **completeness critic**.
- **Newly surfaced by the final round (not in the first pass):** account-deletion orphaning (Theme 10), analytics revenue blindness (Theme 11), the finalize-proposals invoice merge (Theme 12), the staff-add hold-blind overbook (Theme 8), the claim-strand on generic roster ops (Theme 9).
- **Verification note:** the automated per-finding verify agents hit the spend limit; headline findings were verified inline against code, and the five finders (running with no shared memory) **independently converged** on the same `file:line` locations — itself strong confirmation. Convergence with the parallel `ARCHITECTURE_AUDIT_2026-07-11.md` further corroborates the type='cyclus'-shell cluster.
