# Audit — TrainerScheduleOverview's two bespoke invoice writes

**Scope:** the two invoice writes inside `handleSaveCycleEdit` in
`src/pages/TrainerScheduleOverview.tsx` (TSO) that the mutation-boundary work
deferred as P2. Read-only audit; **no behaviour changed by this document.**

**Verdict:** both writes contain real **money bugs**, not stylistic
divergence. They are **untested** and (for the customer-billing logic) **wrong
in the dominant per-player / split-payment billing shape**. The totals recalc
**diverges from the canonical `invoiceSync`/`invoiceCalc` math and is the
incorrect side** in every case where they differ.

---

## Write A — the `booking_ids` MERGE (runs when a cyclus is EXTENDED)

**What it does:** when a trainer increases a running cyclus's session count
(`newCount > cycleSlots.length`), the handler inserts new weekly slots,
auto-books every enrolled player/guest onto them with fresh DB-generated UUIDs,
then *tries* to append each player's new booking ids to **that player's**
unpaid invoice so the line-item quantity (`booking_ids.length`, L714/L751) bills
the extra weeks. `booking_ids` directly drives the charged quantity.

**Trigger:** Edit dialog on the schedule overview → increase the repeat/session
count while existing players have open invoices. (Not on shrink, rename, price,
or extra-cost change.)

| # | Bug | Sev | Evidence |
|---|-----|-----|----------|
| A1 | **Player→invoice matcher is a no-op** → new-session billing misrouted (overcharge one customer, undercharge/unbill another), non-deterministic by query order. | **P0** | `L637-640`: `const ebId = allCycleBookings?.find((_ab) => existingBookings.some((x) => x.player_id === eb.player_id && x.guest_player_id === eb.guest_player_id))?.id;` — the `.find` predicate **never references `_ab`** and the inner `.some` is a **tautology** (`eb` matches itself), so `.find` returns `allCycleBookings[0]` every iteration → `ebId` is a **constant** for every row. Root cause: the two row sets share no joinable column (`existingBookings` has no `id`, `allCycleBookings` has only `id`). The dedup `Set` can't help — the wrong ids are distinct, not duplicates. |
| A2 | Status filter **omits `overdue`** and uses the **dead value `pending`** → overdue unpaid invoices never billed for added sessions; disagrees with Write B (which includes `overdue`). | P1 | `L630 .in("status", ["draft","sent","pending"])`. The `invoices_status_check` constraint allows `draft/sent/paid/cancelled/overdue` — `pending` is not a valid invoice status. |
| A3 | **Not idempotent** — a re-run mints fresh UUIDs the `Set` can't dedup → double-billed. The inline comment claiming the Set guards re-runs is **factually wrong**. | P1 | `insertBookings` mints new UUIDs each call; no transaction wraps slot-insert + booking-insert + invoice-patch, so a mid-loop throw half-patches. |

**Worked example (A1):** 2 players, each with their own single-player invoice,
extend 5→6 weeks. The invoice whose `booking_ids` contains `allCycleBookings[0].id`
receives **both** players' new ids (billed 7, should be 6); the other invoice's
filter yields `[]` and gets **nothing** (billed 5, should be 6 — yet that player
*is* auto-booked and must attend). For a single **group** invoice the constant
branch happens to land correct, masking the bug — so it bites the **per-player
academy** shape, which is the dominant one.

**Other risks:** non-atomic read-modify-write on `booking_ids` (no `updated_at`
guard → lost-update clobber); no write-time paid-status recheck (TOCTOU — a
concurrent mark-paid between SELECT and UPDATE is overwritten); auto-booked rows
copy `payment_amount` from the template booking (stale per-booking price);
mutation-boundary blindness — an inline comment interrupts the
`from('invoices')`→`.update` chain so the guard **doesn't count this write**.

---

## Write B — the extra-cost + TOTAL RECALC (runs on EVERY save)

**What it does:** section 3b re-reads the cycle's bookings → every overlapping
unpaid invoice, and for **each** fully rebuilds `line_items` and overwrites
`subtotal / vat_amount / total / vat_breakdown` (+ nulls `pdf_url`). It is the
write that sets the **total the customer pays**.

**Trigger:** runs **unconditionally** on every cyclus Edit save with bookings +
≥1 overlapping unpaid invoice — including no-op saves (a rename re-derives totals
on every overlapping invoice).

| # | Bug | Sev | Evidence |
|---|-----|-----|----------|
| B1 | **"First-item-only" session rebuild** keeps `line_items[0]` and discards `[1..n]` → undercharge / wrong totals / mis-typed session line. | **P0** | `L723-725 existingItems.filter((_item, idx) => idx === 0)`. Per-session invoices (one line per week) collapse to one week. If `line[0]` is actually an extra-cost/discount line it is re-priced as the session. Quantity is never recomputed from booking count. |
| B2 | **splitCount read from the `(1/N)` description marker only**, ignoring `invoices.split_count` → structural-split invoices re-priced at FULL price (**N× overcharge**). | **P0** | `L716-721` regex over `item.description`. A split invoice minted with `split_count` set but no `(1/N)` text reads `splitCount=1`. |
| B3 | **Exclusive multi-rate `total` diverges from canonical by 1 cent** → `total ≠ subtotal + vat_amount` (internally inconsistent invoice). | P1 | TSO accumulates `total += lineTotal + lineVat` from **unrounded** per-line VAT, rounds once; canonical does `round2(round2(subtotal) + round2(vatAmount))`. Example (excl VAT, €0.01@21% + €13.81@9%): subtotal €13.82, vat €1.24 agree, but TSO total **€15.07** vs canonical **€15.06**. TSO is wrong — `total` must equal `subtotal + vat`. |
| B4 | **Stale `vat_breakdown`**: `hasMultiRate = Set(rates).size>1` differs from canonical "differs-from-default"; breakdown is only spread when non-empty, so a multi→single-rate edit leaves a stale breakdown (mis-renders the PDF). | P1 | `L774` / `L821`. |
| B5 | Extra-cost builder keys on `type==='per_session'` (canonical keys on `one_time`), and omits the canonical `price<=0`/blank skip → junk €0 lines + label/quantity divergence. | P2 | `L749-764`; canonical `invoiceCalc.ts` skips `!description || price<=0`. |

**Risks:** **blind overwrite** (`.update(...).eq('id', inv.id)` with no
`updated_at` lock, no write-time status guard) → clobbers concurrent edits, can
rewrite a now-paid invoice and null its live `pdf_url`; runs on **every** save
with no "extra-costs-changed" guard; silently deletes **manual** line items /
discounts in `[1..n]`.

---

## Divergence verdict

**DIVERGES, and the divergence is itself a bug — TSO is the incorrect side in
every case where they differ.** Three forms: (1) **numeric** 1-cent in the
exclusive multi-rate case (worked example above); (2) **structural** —
`hasMultiRate`/`vat_breakdown` shape oscillates depending on which path last
touched the invoice; (3) **semantic** — line[0]-only, split_count ignored,
one_time/price-skip mishandled. Inclusive and single-rate totals agree
numerically.

## Invariants at risk

- `total == subtotal + vat_amount` — **violated** by B3.
- line-item quantity == count of distinct billable `booking_ids` — **violated**
  by A1 (misrouted) and B1 (line[0] quantity not recomputed).
- A paid/cancelled invoice is never mutated — guarded only at the **read**, not
  the write → **TOCTOU** in both writes.
- `booking_ids` has no duplicate UUIDs — held within one save, but the `Set`
  does not protect against the **wrong-but-distinct** ids A1 routes in.
- `total` reflects the real split share — **violated** for structural-split
  invoices (B2, N× overcharge).
- Consistent unpaid-status set — **violated**: A omits `overdue`, B includes it.

## Test coverage

**Zero** automated coverage on either bespoke write (nothing renders TSO or
invokes `handleSaveCycleEdit`). The **canonical** math is well-tested
(`invoiceCalc.test.ts`, `invoiceSync.test.ts` + `invoiceSync.pglite.test.ts`) —
Write B duplicates it in a divergent untested copy, and Write A (an **additive**
`booking_ids` merge) has **no canonical equivalent** (invoiceSync only ever
*removes* ids). The PGlite harness (`src/test/fixtures/pgliteSupabase.ts`)
supports the read+update surface but not `.insert/.order/.delete`, so a
characterization test must call **extracted helpers** directly (or seed rows via
raw `db.exec`).

## Canonical building blocks to reuse (do not re-implement)

- `src/lib/invoiceCalc.ts`: `calculateVatTotals` (the single totals authority —
  fixes B3/B4), `buildCycleLineItems` (rebuilds ALL lines from real bookings —
  fixes B1/B5), `applySplit`, `detectSplitCount` (fixes B2).
- `src/lib/invoiceSync.ts`: `applyGuardedInvoiceUpdate` + `withOptimisticRetry`
  (+ `UNPAID_SYNC_STATUSES`, includes `overdue`) — the optimistic-lock /
  paid-recheck primitives both writes lack; `regenerateInvoicePdf`. Currently
  module-private → export or wrap.
- **No** additive `booking_ids` merge exists → the new
  `mergeNewBookingIdsIntoCycleInvoices` owner is genuinely new code but should be
  built on the same guard primitives + canonical helpers.
- `invoiceFormTotals.ts` is the deliberate create/edit FORM copy — **not** on
  this path; do not route through it.

## Remediation plan — behaviour-FREEZE-then-separate-fix (NOT fix-as-you-go)

Both writes carry multiple independent money bugs, so mixing characterization
and fixes in one PR makes the money diff unreviewable. Sequence:

1. **PR-1 (INERT):** extract the two write bodies verbatim into named lib
   helpers (e.g. `src/lib/cycleEditInvoiceSync.ts`), add **PGlite
   characterization tests pinning TODAY's buggy output bit-for-bit** with
   explicit `BUG:` comments at each wrong assertion (Test A: 2-invoice/2-player
   extend-by-1; Test B: exclusive multi-rate + dropped `line[1..n]` + stale
   breakdown). Fix the mutation-boundary mis-count in the same PR (reformat so
   `WRITE_RE` catches the merge write, set the allowlist to the true count).
   - **✅ PR-1a SHIPPED (Write A):** `mergeNewBookingIdsIntoCycleInvoices` lives
     in `src/lib/cycleEditInvoiceSync.ts`, called verbatim from TSO; pinned by
     `src/test/cycleEditInvoiceSync.pglite.test.ts` (per-player misroute = bug
     A1; group invoice = accidentally-correct; paid-invoice excluded = A2). The
     **mutation-boundary mis-count is resolved by the extraction itself** — the
     previously-uncounted merge write (the interrupting comment hid it from
     `WRITE_RE`) is gone from `src/pages`; it now lives in the unscanned `src/lib`
     domain layer, so no comment-reformat/allowlist bump is needed for it. TSO
     stays allowlisted at 3 (the recalc write leaves in PR-1b → 3→2 there).
   - **✅ PR-1b SHIPPED (Write B):** `recalcCycleInvoiceTotals` lives in
     `src/lib/cycleEditInvoiceSync.ts`, called verbatim from TSO; pinned by
     `src/test/cycleEditInvoiceTotals.pglite.test.ts` (B1 line[0]-only drop; B2
     unmarked-split re-priced at FULL vs marked stays split; B3 exclusive
     multi-rate total 15.07 ≠ subtotal+vat 15.06; B4 stale vat_breakdown). The
     5 `any` annotations moved with the body (eslint-suppressions: TSO 12→7, new
     file +5) and the recalc invoice `.update` left `src/pages` → TSO
     mutation-boundary allowlist **3→2**. Adversarial review = VERBATIM. **The
     two bespoke writes now both live in the tested lib owner — PR-1 (inert
     freeze) is COMPLETE.** Next: PR-2 (matcher fix) + PR-3 (canonical recalc).
2. **PR-2 (BEHAVIOUR CHANGE — matcher fix): ✅ SHIPPED.** The no-op `.find`
   matcher is replaced with a real per-player join — the cycle's existing
   bookings are read WITH `player_id/guest_player_id`, mapped `bookingId →
   playerKey`, and each invoice's billed players are derived from its own
   `booking_ids` so a player's new bookings land ONLY on the invoice(s) covering
   that player. Test A flipped to correct (per-player `INV_A=[bA,nA]`/
   `INV_B=[bB,nB]`; guest keyed on `guest_player_id`; group gets all; mixed
   invoice preserves a foreign id + isolates other players). Order-dependence
   gone (per-id Map, not `allCycleBookings[0]`). 3-lens adversarial review =
   correct-ship. The now-redundant `existingBookings` param + `ExistingCycleBookingRow`
   type were dropped from the merge (TSO still uses `existingBookings` for its own
   auto-booking). **Still open (NOT this PR):** A2 (status set — flagged owner
   decision) + A3 (cross-rerun idempotency).
3. **PR-3 (BEHAVIOUR CHANGE — recalc replacement): ✅ SHIPPED.** The bespoke
   recalc is deleted; `syncInvoicesAfterCycleEdit(cyclusId)` now DELEGATES to the
   canonical `syncInvoicesAfterPriceChange` (the same resync CycleDetailView /
   slot-detail edits use) — rebuilds all line items from the real bookings, reads
   `invoices.split_count`, `total = round2(subtotal+vat)`, clears stale
   `vat_breakdown`, guarded `updated_at` optimistic write. Fixes B1–B5 + the
   TOCTOU. Unpaid-status set aligned to `['sent','draft','overdue']` (A2 closed,
   passed explicitly since the canonical default omits `overdue`). The recalc is
   GATED in TSO to an actual price/extra-cost/length/VAT-mode change (a benign
   rename no longer rewrites every overlapping invoice). R1 fix: `cycles.settings.
   extra_costs` is persisted before the recalc (the canonical resolver prefers it
   over the slot value). Test B flipped to canonical (B1 rebuild / B2 split from
   split_count / B3 total 15.06=subtotal+vat / B4 breakdown cleared). 3-lens
   adversarial review = correct-ship. **Known consequences (intended — they make
   TSO consistent with every other cycle-price-edit path):** explicit per-booking
   `payment_amount` lines don't re-price on a price edit (M-21); manual invoice
   lines are rebuilt away; invoice discovery is via `confirmed/pending` bookings.
   **Pre-existing gap (NOT a regression, NOT addressed here):** toggling split
   **OFF** on an already-invoiced cyclus does not un-split the existing invoices
   (the old bespoke recalc never un-split either; only OFF→ON re-splits). Needs an
   owner decision + a symmetric un-split path if desired.

**End state REACHED:** one owner `syncInvoicesAfterCycleEdit(cyclusId)` collapsing
the two bespoke writes into guarded canonical passes, with the unpaid-status set
aligned. Both fix PRs (#210 PR-2, PR-3) and the inert freeze (#208/#209) are done.

## Open questions for the owner (decisions, not assumptions)

1. **Live/historical exposure** — any invoice touched by a cyclus EXTEND on a
   per-player or structural-split cyclus may already carry a wrong total. Run a
   **read-only reconciliation** (stored `total` vs recomputed canonical total
   for unpaid cycle invoices) to size the blast radius + find customers to
   re-bill/refund **before** the fix ships?
2. **Hotfix-ahead?** A1 (misroute) and B2 (split-count N× overcharge) are P0
   customer-billing bugs — fix them ahead of the full refactor, or do the full
   freeze-then-fix sequence?
3. **Trigger** — should the recalc keep running on EVERY save, or be gated to
   "extra-costs/price/length actually changed"? (Today a benign rename
   re-derives totals on every overlapping invoice.)
4. Confirm the canonical unpaid-status set is exactly `['sent','draft','overdue']`
   (drop the dead `pending`) and that both writes must agree.
