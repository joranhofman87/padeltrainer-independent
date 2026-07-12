# Architecture Audit — Cycles ⇄ Registrations & the Cycles/Slots/Players Triangle

**Date:** 2026-07-11 · **Status:** consolidated (single canonical document — supersedes the separate `CYCLES_SLOTS_PLAYERS_SEPARATION_AUDIT_2026-07-11.md`).
**Method:** two independent fresh-eyes multi-agent audits + a third resume round, code + SQL migrations only (no memory; repo `docs/` treated as unverified claims). Audit 1: cycles/registrations separation. Audit 2: cycles/slots/players integrity. Resume round: money-path finder, players-roster finder, completeness critic. Every finding is anchored to `file:line`.

> **Verification status.** The Claude spend limit interrupted the automated 2-lens verification twice. **All mapping completed** (6 mappers + resume mappers); **all 7 finders + the completeness critic completed**; **6 findings received full 2-lens verification (V1–V6, all confirmed)**, and the headline P1/P2s below were **verified inline against code** during consolidation. Findings marked *[raw]* are single-auditor claims with `file:line` evidence — high-confidence but verify the exact code before building each fix. The five finders ran with **no shared memory and independently converged** on the same `file:line` locations — that convergence is itself strong corroboration.

---

## 1. Verdict in plain language

**Your instinct is correct — cycles and registrations ARE mixed, and the mixing is structural, not incidental.** But three sub-answers matter:

**(a) Are cycles & registrations mixed up?** The `cycles` table is a polymorphic container for three products (weekly training *cyclus*, sign-up *registration*, one-off *event*) discriminated by a single `type` column, and **nothing in the schema enforces the separation** — no constraint ties a type to which columns/relations a row may use. Only **~4 query sites filter by type at the DB level**; ~40 read sites apply none. Two decisions turned "untidy" into "actively leaking":
1. **The registration split is half-migrated.** The canonical write path `create_registration_with_cycle` mints every new registration/event as a **cycles shell born `type='cyclus'`**, with the real form in a separate `registrations` overlay. So `cycles.type` is now a *legacy* discriminator that no longer means what most code assumes — every pre-split type-gate misfires for post-split rows, **in both directions**.
2. **`cycles.settings` is one JSONB carrying four concerns** (booking flags, generator provenance, the ~17-key rebook state machine, registration form config); several writers rebuild it wholesale, so one concern's save erases another's.

**(b) Are cycli fully disconnected from registration forms?** **No — by convention, not by construction.** No DB constraint conditions on type; both directions leak (an open cyclus/rebook round renders a working `/register` form and mints intakes; duplicating/editing a registration turns it into a rebook round).

**(c) Is the cycles⇄slots⇄players triangle consistent?** **Write side: healthy** — the slot⇄cycle FK is enforced (though `NOT VALID`), the trainer-overlap trigger covers all creation paths, one `bookings` ledger, atomic capacity-locked RPCs. **Read side: not** — at least **four different "who's in / how full" definitions**, name/price/date drift between a cycle and its slots, and the **linked-guest (family) identity** model honored by some surfaces and violated by others. This is the mechanical root of the "weird cases."

---

## 2. VERIFIED findings (full 2-lens or inline verification)

| # | Sev | Finding | Consequence | Fix |
|---|-----|---------|-------------|-----|
| **V6** | **P1** | **Every generic cancel/remove/swap leaves `slot_priority_claims` stuck `'claimed'`.** `cancelBookingsAndSync`/`cancelPlayerBookingsInCycle` write bookings+invoices only; **7 surfaces** cancel via them, only rebook free-the-seat pairs the claim decline. `swapPlayerInCycle` repoints the booking without re-keying the claim. The 2026-07-10 sweep heals only hold-marked deaths. | False "Geherboekt" forever, dead player link, **suppressed resale** of the freed seat, wrong paid/outstanding counters. **The confirmed root of the historical "weird cases."** | One cancellation facade: bookings→claims→invoices, always. (Batch 0.) |
| **V-money** | **P2→P1** | `finalize-proposals` merges training `booking_ids` onto an **unpaid registration invoice** ([finalize-proposals/index.ts:204-212]); it then looks like a booking invoice to the sync engine, and a later slot-price edit/cancel rebuilds its `total` from `availability_slots.price_per_session` ([invoiceSync.ts:509-544]). | Registrant quoted €50 registration fee (unpaid) is silently re-billed the slot-based training total (e.g. 12×€22). Escalates to P1 in academies that finalize before payment clears. | Don't overload `booking_ids` on a `cycle_id IS NOT NULL` invoice, or make the sync engine skip `cycle_id`/`registration_id` invoices. |
| **V-hold** | **P1** | Staff roster-add capacity trigger is **hold-blind**: `enforce_booking_slot_tier` counts confirmed/pending/pending_approval only ([20260702140000:63-67]), while the public read + pay-first RPCs count live `payment_pending` holds. | Public slot at max via in-flight guest checkouts shows **full** to the public but **0 taken** to the staff trigger → the roster-add succeeds → **oversold** on hold-convert. A money-path overbook. | One canonical hold-aware occupying predicate everywhere. (Batch 3.) |
| V1 | P2 | `submit-guest-intake` accepts ANY cycle id — no type/status check before insert + guest + follow + confirmation email; a **CLOSED registration still mints a payable invoice** via the source-cycle fallback. | Anon "registers" for training cycli/rebook rounds; closing enrollment isn't enforced server-side. | Server gate: require an overlay row (or legacy type ∈ reg/event) AND overlay `status='open'`. |
| V2 | P2 | `generate-proposals` deletes every unbooked slot of ANY owned cycle (owner-auth only, no type guard) and regenerates; precondition (≥1 `new` intake) is seedable by V1/V3. Bookings/**claims CASCADE away**. | Silent irreversible deletion of sellable sessions + rebook claims if run on a cyclus. | Require an overlay row before the destructive block. |
| V3 | P3 | Manual intake dialog fed by unfiltered `getCycles` — staff attach a registration intake to any cyclus/rebook round in two clicks. | Concern pollution; arms V2. | Filter the picker (overlay-aware). |
| V4 | P3 | `update_registration_with_cycle` (SECURITY DEFINER, granted `authenticated`) adopts ANY owned cycle + **full-replaces `cycles.settings`** (`COALESCE(p_settings, settings)`). | A direct RPC call wipes booking flags + rebook run-state; only a client ternary prevents it. | Type/overlay guard inside the RPC; merge whitelisted keys, don't replace. |
| V5 | P3 | `split-invoice` stamps `settings.split_payment=true` on whatever cycle owns the slots — no type check — and the mirror trigger fans it to all its slots. | One courtesy split flips future pricing for a whole cycle, incl. registration-owned slots. | Scope the write / stamp per-slot. |

---

## 3. Cycles ⇄ Registrations findings (raw; `file:line` recorded)

### 3.1 "Split-brain registration" cluster — ⚠️ headline (raw P0/P1)
Post-split registrations live in TWO rows (cyclus-typed shell + overlay); writers and readers disagree on which is authoritative:
- **[raw P0] Editor writes the wrong row.** `CycleFormPage` loads the shell, sees `type='cyclus'`, forces the plain-cycle write ([CycleFormPage.tsx:255-262], verified) → **every edit to a post-split registration updates only the shell, never the overlay** the public form renders and prices. Raise a price €25→€30 → registrants keep paying **€25**.
- **[raw P1] "Close" doesn't close.** The toggle writes `cycles.status` only ([AcademyCycleDetail.tsx:391-401]); the split form reads `registrations.status`, so it **stays live and keeps minting invoices**. (Precision: split forms stay open; legacy no-overlay forms *do* close via the cycle-status fallback.)
- **[raw P1] Delete is broken / orphans.** `registrations.source_cycle_id` is `ON DELETE RESTRICT` (no code deletes overlays) → deleting a split registration errors; `delete-user-data` leaves cycles+registrations behind (privacy) — see Theme "account deletion" below.
- **[raw P2] Paid-registration enforcement fails open** if the overlay lookup transiently errors → guest enrolled in a paid registration **for free**, no alert.

### 3.2 Type-gate dissolution (the `type='cyclus'` pivot)
- **[raw P1]** New registrations/events pass every `type='cyclus'` gate — rebook source picker lists them, `bulk-rebook-cycle`'s guard passes, cyclus-label RPCs dress them as training cycles.
- **[raw P2]** Cohort-mode rebooking (location+term-end) never consults type ([bulk-rebook-cycle/index.ts:400-406]) — a finalized registration's slots get swept into rounds; the guard exists only in `sourceCyclusId` mode.
- **[raw P3]** `get_academy_cyclus_groups`' registration special-casing keys on `type='registration'` → dead for post-split rows.

### 3.3 Legacy BulkCopy "next round" wizard (raw P1/P2)
`BulkCopySlotsWizard` has **zero type filtering** and copies `type` + full `settings` + `status:'open'` ([BulkCopySlotsWizard.tsx:64-177]):
- a registration/event source becomes **simultaneously a live public form AND a rebook round** (two uncorrelated billing engines on one seat);
- copying a former rebook target **inherits the old `rebook_round_id`** → aggregates into the OLD round, member-open emails suppressed;
- **[raw P1]** the public `/register` form renders for any OPEN `type='cyclus'` row (rebook rounds!) via `cycles_public` (status-only) + `getPublicCycle` fallback ([CycleRegistration.tsx:73-83]) → a guest "registers" for a rebook round, gets the official email, holds nothing.

### 3.4 Settings-blob & exposure hazards
- **[raw P2]** Editing a rebook round (or a booked cyclus via the trainer player-detail link, [trainerCyclusPricingRoute.ts:15-21]) through the cycle editor **rebuilds settings from form state** ([CycleForm.tsx:556-598]) — wipes all ~17 `rebook_*` keys + `generated_by` + `excluded_dates`; the round vanishes from the hub. (Same class as V4.)
- **[raw P3]** `cycles_public` strips only 2 keys ([20260706130300:35]) → the rebook engine's full run-state (priority-people UUIDs, message bodies, prices) is **anon-readable** for every open round.
- **[raw P3]** SEO prerender (`render-page/db-facts.ts:379-393`) selects cycles with **no type/status filter** → drafts/closed/internal rounds leak into bot-visible marketing with prices.

### 3.5 Billing seams
- **[raw P2]** `finalize-proposals` graft (see V-money above — now verified).
- **[raw P3]** Commitment-invoice cron identifies rebook cycles by *the mere existence of claimed claims* — full scan, no type/owner gate ([generate-cycle-commitment-invoices/index.ts:52-56]); saved only by data shape.
- **[raw P3]** Registration-invoice idempotency keys on `(cycle, registrant)` — a **parent registering two children under one account** gets one payable invoice; the 2nd child's charge collapses → **under-collection** ([20260621110000:14-17]).
- **[raw P2]** `intake_requests.status` CHECK in migrations = 5 values, but code writes `'booked'` **and `'notified'`** and reads `'pending'` ([finalize-proposals:90], [send-schedule-notifications:113,180]) → **any env built from migrations breaks on first approval**; prod's constraint was dropped out-of-band (lifecycle no longer in version control).

---

## 4. Cycles / Slots / Players triangle findings (raw; `file:line` recorded)

### 4.0 Four (really six) definitions of "who's in / how full"
| Surface | Occupancy set | Source |
|---|---|---|
| DB capacity truth (booking RPCs, public occupancy) | confirmed+pending+pending_approval **+ live payment_pending holds** | [20260706140000:27-30] |
| Cycle-detail roster / slot detail | confirmed+pending+pending_approval (no holds) | [cycleDetail.ts:87] |
| Agenda + academy calendar | confirmed+pending only | [agendaSlots.ts:62-64] |
| Players-overview list | confirmed/**completed** only | [get_players_overview:129] |
| Cyclus-overview | bookings **UNION intake names**, deduped by **name** | [get_academy_cyclus_groups:139-198] |
| BulkCopy occupancy | `.neq('cancelled')` (counts rejected/swap/completed) | [BulkCopySlotsWizard] |

Failures: a `pending_approval` seat is *open* on the calendar but *occupied* to the trigger (staff add → `slot_full`); a `pending`-only player is in cycle-detail but absent from the players list; a `completed`-only player is in the players list but absent from cycle-detail; two humans named "Jan de Vries" = 1 on the overview (name key) but 2 on cycle-detail (id key). **Fix: one canonical hold-aware predicate + one roster source, routed everywhere.**

### 4.1 `payment_pending` holds are second-class (money-loss)
- **[raw P1]** Slot-delete protection ignores live holds → deleting a slot whose only occupant is a mid-checkout hold CASCADE-destroys the hold+claim; the later webhook finds nothing (amount guard disabled, `expectedSum=0`) → logged `duplicateWebhookIgnored`: **money captured, no seat, no alert**.
- **[raw P1]** Late Mollie payment on an **expired** hold confirms with **no capacity re-check** → oversell (max+1).
- **[raw P2]** Capacity-shrink guard ignores live holds → over-capacity on confirm.

### 4.2 Cancellation doesn't propagate (see V6 — verified)
Plus: **[raw P2]** removing a **paid** player records no credit/refund (the paid-mismatch signal is computed then discarded); **[raw P2]** cycles-list "Delete cycle" deletes only the cycles row → sessions/bookings/claims orphan (`cyclus_id`→NULL) while still rendering with a stale `cyclus_name`; **[raw P2]** DeleteSlotDialog's cancel UPDATE is unchecked (emails "cancelled" + rewrites invoices even if the bookings survive); **[raw P3]** whole-cycle removal uses `.neq('cancelled')` → rewrites `completed` history.

### 4.3 Family / linked-guest identity (FAM-02) honored inconsistently — ⚠️ recent code
FAM-02 doctrine: a linked guest may be a **different person** (child) under a parent's account; dual-keyed bookings are the designed state.
- **[raw P1]** The rebook cohort canonicalizer (`_shared/rebook-cohort.ts`, added 2026-07-10 for the 23505 fix) **merges parent + linked child into one claim** → the child silently gets no invite/seat next round. *(Design tension vs the duplicate-claim fix — needs a deliberate identity rule.)*
- **[raw P1]** Whole-cycle "Remove" matches player-first (cancels **both** parent+child seats) while "Change" matches guest-first — the two actions on one row hit different booking sets.
- **[raw P2]** `get_players_overview` regressed to profile-first names → linked kids show the parent's name/rating; the parent's own row can disappear.
- **[raw P2]** Roster keying `player_id ?? guest_player_id` splits one person into two entries when bookings are mixed-keyed (post-link staff adds are guest-only).
- **[raw P2]** Rebook manage flips a PAID rebooker to "unpaid" after sign-up (linker re-keys invoices to player_id but claims stay guest-keyed).

### 4.4 Duplicate seats
- **[raw P2]** `pending_approval` double-submit not covered by M-17 indexes → one player holds 2 of 4 seats (23505 at approval).
- **[raw P2]** Guest pay-first RPCs dedup only vs a live hold, never an active booking → double-hold; if the first seat was **paid**, the 2nd charge is silently kept.
- **[raw P3]** M-17's dual-key exemption (`uniq_active_booking_per_slot_player WHERE guest_player_id IS NULL`, [20260612140000:49-52]) → the same human can hold a pure-profile AND a linked-guest booking on one slot; `bookedCount`=2, roster dedups to 1 → badge 2/4 vs 1 name, silently over-occupied.

### 4.5 Numbers that lie (reporting)
- **[raw P1]** Dashboard analytics revenue substitutes **full slot price for every €0/NULL paid booking** (covered group seats, webhook writebacks) → a captain-paid group of 4 shows ~**4× real revenue**. **Separately**, analytics revenue reads **`bookings` only** ([dashboard_analytics.sql:41-42,125-126]) → **omits ALL registration/event/rebook *invoice* income** (money routed through `invoices`, not bookings).
- **[raw P1]** Academy bookings RLS scoped via **active** trainer membership → a departed trainer's bookings vanish from reports **retroactively**.
- **[raw P1]** `AcademyCalendar` month reads are unpaginated + status-unfiltered → **1000-row PostgREST truncation** under-counts trainer-hours (payment CSV). Same class as the "49 not sent" incident; the `fetchAllPages` fix exists only in `rebookManage`.
- **[raw P2]** `get_academy_cyclus_groups` scopes by active-trainer, not academy → departed trainers' cycles report "no players"; a dual-academy trainer **leaks the other academy's slots + player names** (SECURITY DEFINER).
- **[raw P3]** Rebook hub `openSpots` subtracts distinct **people** from summed **seats** (multi-series rebookers under-decrement).

### 4.6 Account deletion (untouched subsystem — critic)
- **[raw P1]** `_shared/delete-user-data.ts` (admin `delete-user` + self-service `request-account-deletion`) deletes cycles by owner with **zero type awareness**; the academy/club branches ([:76-80,:108-112]) use **bare awaits that swallow FK errors** and **never delete the cycles' `availability_slots`** → orphaned slots with **dangling bookings + claims**. Cross-type + orphaning + privacy in one path.

---

## 5. What is genuinely sound (verified)

- **The money layer's structural separation is provably sound** (money-path finder). Three idempotency keys on three columns — event `(cycle_id, registrant)`, rebook-single `(rebook_cyclus_id, registrant)`, rebook-group `(rebook_group_id)` — and **booking invoices provably keep `cycle_id` NULL** (`auto-create-invoice` never sets it; the *only* insert that does is the event/registration minter). So a training-cyclus booking invoice and an event/registration invoice **cannot collide on a key**. The minter refuses to charge a `cyclus`; `update_cycle_pricing` writes only slot columns (never the overlay price); the zombie sweep is scoped to rebook-tagged invoices. The one runtime money defect is V-money (§2).
- **Slot⇄cycle FK enforced for new rows; trainer double-booking closed at DB level across all creation paths (incl. service-role); split-payment mirror trigger makes the cycle authoritative for its slots; tier gates enforced server-side.**
- **One write-ledger for players.** No intake→booking write leak (the overview's intake merge is read-only); `merge_guest_players` keeps all four attachment ledgers in sync; the pay-first/public-read cluster agrees with itself; the **guest cart** money path fails closed at the slot-tier level.
- **The `registrations` overlay direction is right** — the problem is the half-migrated state, not the destination.

### Structural gaps (open guarantees, not bugs)
- **`availability_slots.cyclus_id → cycles` is `ON DELETE SET NULL` AND `NOT VALID`** ([20260630120000:45-49,57-81]) — validation is a manual owner step; the FK doesn't cover pre-existing rows, so every cross-type cycle delete **orphans slots rather than cascading**. Underpins §3.1, §4.2, §4.6.
- **No index on `cycles.type`** — the discriminator hot reads filter by; only `owner`, `status`, `location_id` are indexed. Fine at current scale; unassessed.

---

## 6. Structural recommendations (enforced-by-construction, proportionate)
1. **Finish the registration split as a hard boundary.** One `upsertRegistration` facade that always writes the overlay; make the shell an implementation detail (or give shells a dedicated type so old `type='cyclus'` gates stop matching). Fix edit/close/delete to route through it.
2. **Type/overlay guards inside every SECURITY DEFINER write** that takes a cycle id (`generate-proposals`, `update_registration_with_cycle`, intake inserts, split-invoice, `delete-user-data`). Client gates are not guards. **Validate the `cyclus_id` FK.**
3. **Split `cycles.settings` by concern** — writers merge whitelisted keys not replace; a `rebook_state` sub-object owned only by the engine; `cycles_public` → public-key whitelist.
4. **Promote live `payment_pending` holds into one canonical occupying predicate** (one SQL + one TS constant) used by delete/shrink/report/staff-add guards.
5. **One cancellation facade** that always propagates bookings→claims→invoices (+ paid-mismatch surfaced), used by every staff surface.
6. **One identity-resolution module** implementing FAM-02 (person key, display name, dedup), used by rosters, rebook cohort, counters, name rendering.
7. **Paginate every unbounded read** (`fetchAllPages`); add a lint/grep gate for `.in(` reads without `.range(`. Fix analytics revenue for €0/NULL bookings **and** to include registration/event invoice income.
8. **Deprecate or type-gate `BulkCopySlotsWizard`.**

---

## 7. EXECUTION PLAN (each batch = 1–3 PRs; verify raw findings inline before fixing)

**Batch 0 — Cancellation propagation facade *(VERIFIED P1 — V6; start immediately)*.** One `cancelSeats()` that always: cancels bookings (status allowlist, not `.neq('cancelled')`) → declines non-paid claims (or re-keys on swap) → syncs invoices → **surfaces the paid-mismatch list**. Rewire all 7 generic surfaces + `swapPlayerInCycle`. Migration-free lib PR + PGlite test.

**Batch 1 — Registration split-brain (§3.1 + V1–V4).** Editor routes by **overlay existence** not shell type; list Open/Close toggles the overlay; delete path handles the overlay + `delete-user-data`; `submit-guest-intake` + authed twin gate on overlay-open; `generate-proposals` requires an overlay row; intake picker filtered; type/merge guards in `update_registration_with_cycle`. 2–3 PRs.

**Batch 2 — Money truth (V-money + §4.5 + new raw P1s).** finalize-proposals `booking_ids` overload → sync skips `cycle_id`/`registration_id` invoices; price-mirror drift → one authoritative cycle+slot price facade; price-change no-op on explicit `payment_amount`; reconcile the two invoice-rebuild engines to one price truth; divisor fork → frozen-capacity rule everywhere; repeat-extension must not copy `payment_status`; mark-paid must not clobber `payment_amount`; extra_costs charge/invoice must agree; **"invoice after N weeks": build the biller or remove the option (owner decision)**; analytics revenue (€0 bookings + invoice income).

**Batch 3 — Holds first-class (§2 V-hold + §4.1).** Live `payment_pending` joins the canonical occupying set used by delete/shrink/staff-add guards and staff-visible counts; webhook alerts when a paid payment matches zero booking rows.

**Batch 4 — FAM-02 identity ruling (§4.3; owner decision first).** Decide once: when is a dual-keyed booking the *same person* vs a *linked family member*? Then align cohort canonicalizer, roster keying + remove/swap scope, players-overview name order, name resolution, rebook paid-resolver. One identity module.

**Batch 5 — Reports/numbers truth (§4.5 + §4.0).** `fetchAllPages` on calendar/reports/summary; single occupying set; dashboard revenue semantics; `get_academy_cyclus_groups` academy scoping (+ cross-tenant leak); overview bulk-action series keys; hub openSpots seat-units.

**Batch 6 — Containment & hygiene.** `cycles_public` key whitelist; SEO facts type+status filter; BulkCopy retire/gate; settings writers merge-not-replace; `intake_requests.status` CHECK migration (`'booked'`+`'notified'`); remaining P3s.

**Owner decisions before their batches:** B2 (N-weeks biller: build vs remove) · B4 (family identity rule) · B6 (retire vs gate BulkCopy).

---

## 8. Prod checks (cannot be answered from code — do before Batch 1/2)
- **`\d intake_requests`** — does the `status` CHECK include `'booked'` **and `'notified'`**? (Confirms §3.5 drift + that split RPCs are deployed → §3.1 live vs latent.)
- **`select count(*) from cycles c join registrations r on r.source_cycle_id=c.id where c.type='cyclus'`** — registrations affected by the edit-routing P0.
- **`select count(*) from cycles where type='registration'`** — legacy (un-split) forms remaining.
- **`select convalidated from pg_constraint where conname='availability_slots_cyclus_id_fkey'`** — is the FK validated? (Governs §3.1/§4.2/§4.6 orphaning.)

## 9. Provenance
Consolidated from two independent fresh-eyes audits (workflows `wf_ad3945b1-613`, `wf_d79a5d1d-0e4`) + a resume round (money-path, players-roster, completeness-critic). Resumable from cache if the spend limit is raised — only outstanding verify agents would run. This file is the single canonical audit; the earlier `CYCLES_SLOTS_PLAYERS_SEPARATION_AUDIT_2026-07-11.md` was merged into it.
