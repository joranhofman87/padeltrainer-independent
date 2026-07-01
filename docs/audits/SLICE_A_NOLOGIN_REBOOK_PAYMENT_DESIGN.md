# Slice A — no-login, full-cycle rebook payment (design for review)

**Date:** 2026-07-01
**Status:** DESIGN ONLY — hand to Codex for a money-path second-look before building.
**Owner decisions this implements:** #1 (every rebook is full price) + #2 (email → checkout → pay, **no login**).
**Codex finding it closes:** P1 (upfront individual rebook has no working payment path for logged-out/guest players).

Grounded by a 6-area read-only map of the payment internals (2026-07-01).

---

## 0. Codex review outcome (2026-07-01) — corrections applied

Codex reviewed this design (verdict: **approve the approach, request design changes before coding**) and raised 4 findings, all of which I re-verified against the code and confirmed. Sections 2–5 below are **corrected accordingly**. The confirmed core premises (group path is token-gated/no-login; `/pay/:token` is no-login per `verify_jwt=false`; invoice-branch amount + cancelled guards; charge-org symmetry via `invoice.academy_profile_id`) all hold.

| Codex | What was wrong in v1 | Correction now baked in |
|---|---|---|
| **F1 (P0)** — claim lifecycle | v1 said "the webhook marks claims `claimed`". The webhook does this **only in the booking branch** (`mollie-webhook:743-760`), NOT the invoice branch. | The claim is marked `claimed` at **accept** time by `respond_to_priority_claim` (before the invoice). The webhook's invoice branch marks **bookings** paid only — no claim writeback needed. Lifecycle = **accept-before-invoice** (explicit). Abandoned-after-accept: non-strict = a confirmed-but-unpaid commitment (same as deferred); strict = see F3 cleanup. |
| **F2 (P1)** — "full cycle" scope | v1 was ambiguous ("one claim's slots" vs "claim/group/cyclus"). | **Full cycle = ALL pending/claimed claims for the same claimant identity (`player_id` OR `guest_player_id`) across the target `cyclus_id`**, derived **server-side from the token** — mirrors the current cycle-scoped fan-out (`priorityClaims.ts:906-912`) but by identity, not `eq('player_id')` (which is null for guests). Never accept client booking IDs. |
| **F3 (P1)** — strict mode | v1 said strict release is "moot because the invoice path reserves confirmed bookings". Wrong: `respond_to_priority_claim` inserts `payment_pending` + `hold_expires_at=now()+15min` when `rebook_strict_mollie` (migration `20260703150000`). | The new fn must do **group-style server-side strict cleanup** (mirror `create-group-rebook-invoice:157-168`): if strict and checkout can't start, cancel the invoice/bookings + reset claims to `pending`. Do **not** rely on `release_rebook_hold` (auth-owned; a guest can't call it). |
| **F4 (P2)** — full price | v1 said `splitAmongPlayers=null` forces full price. Wrong: `auto-create-invoice:122-128` auto-splits when `slot.split_payment===true` and the batch has >1 distinct player. | **Pass only the claimant's OWN booking rows** (1 distinct player → auto-split can't fire), which carry no pre-split `payment_amount`. Add a structural test that a split-payment slot with other participants still mints a full-price rebook invoice. Optionally add an explicit `forceFullPrice` flag to `auto-create-invoice` as a backstop. |

Non-blocking (opportunistic): `get-public-invoice` doesn't pass `_academy_profile_id` to `get_invoice_recipient_identity`, so academy billing-email overrides aren't applied to the public-page display (`get-public-invoice:88-99`); `send-invoice-email` does pass it, so delivery is fine.

**Owner decision (2026-07-01) — deferred mode:** full price applies ONLY to the **upfront no-login checkout** that Slice A builds. The **deferred** mode (invoice at cycle start) stays **as-is with its ÷headcount split** — Slice A does **not** touch the deferred minter. (So the same cycle costs full price via pay-now, or a split share via deferred invoicing.)

---

## 1. The gap, precisely

The owner's flow is: click **YES** on a rebook invite → go to **checkout** → **pay the full cycle**, **no login**. Today only *part* of that works:

| Path | Token-gated / no-login? | Evidence |
|---|---|---|
| **Group** rebook (captain pays for the whole group) | ✅ **Already no-login** | `create-group-rebook-invoice` is token-gated: runs as service role after verifying `claim_token`, no auth header, treats `guest_player_id` like `player_id`, mints one full-price invoice → returns `checkoutUrl`/`publicToken` |
| **Single** (non-group) rebook | ❌ **Login required** | `acceptClaimAndStartPayment` calls `getUser()` at [priorityClaims.ts:883](src/lib/priorityClaims.ts:883); a claimant with no `auth.uid()` returns `upfront_unavailable`. Downstream `create-mollie-payment` ([:231-235](supabase/functions/create-mollie-payment/index.ts:231)) and `create-rebook-invoice` ([:31-59](supabase/functions/create-rebook-invoice/index.ts:31)) each require `booking.player_id === caller.profile.id` — guest-keyed bookings (`player_id=null`) are rejected |
| **`/pay/:token`** checkout + confirm | ✅ **Fully no-login** | `PublicInvoicePay` → `get-public-invoice` (service role, no `verify_jwt`) → `create-invoice-payment` (token-based, no JWT) → `mollie-webhook` invoice branch (amount-match, marks paid, flips `booking_ids` to confirmed/paid, resolves recipient via `invoice.academy_profile_id`) |

**So the fix is narrow:** give the **single claim** the same token-gated invoice mint the **group** path already has. The `/pay/:token` stack needs **zero changes**; the webhook's invoice branch already marks the invoice + its bookings paid (the *claims* are set `claimed` at **accept**, not by the webhook — see §0/F1).

---

## 2. Chosen approach — token-gated invoice → `/pay/:token` (reuse the group pattern)

**YES on a single claim (no login) →** a token-gated edge function that, given the `claim_token`:
1. Derives the **full-cycle scope server-side** from the token: ALL pending/claimed claims for the same claimant identity (`player_id` OR `guest_player_id`) across the target `cyclus_id` (F2). Accepts each via `respond_to_priority_claim` (anon-callable; preserves `guest_player_id`) — which **marks the claims `claimed`** and creates the booking rows. **Never accepts client-supplied booking IDs.**
2. Mints **one full-price invoice** over **only the claimant's own booking rows** via `auto-create-invoice` (guest-aware; keys `player_id` **or** `guest_player_id`). Because the batch is a single identity, the auto-split can't fire → full price (F4).
3. Returns the invoice `public_token` (+ optional `checkoutUrl`).
4. Client redirects to **`/pay/:token`** → existing `create-invoice-payment` → `mollie-webhook`'s invoice branch marks the **invoice + its bookings** paid/confirmed. The **claims are already `claimed` from step 1** — no webhook claim writeback needed (F1).
5. **Strict mode** (`rebook_strict_mollie`): step 1 creates TTL `payment_pending` holds. If checkout can't start, the fn **cancels the invoice/bookings and resets claims to `pending` server-side** (mirrors `create-group-rebook-invoice`); it does **not** call the auth-owned `release_rebook_hold` (F3).

This mirrors `create-group-rebook-invoice` closely; the differences are scope (the claimant's cyclus-wide claims instead of the group's) and the single-claim double-pay guard.

### Why this over the alternative (guest pay-first holds)
`book_guest_cyclus_for_payment` + `create-guest-cyclus-payment` (the public-booking stack) could also work — mint `payment_pending` TTL holds → Mollie → webhook. But:
- It commits TTL holds *before* payment and needs new claim-linking + a group-roster-after-pay story (rosters don't expire, holds do).
- The invoice path **already exists for the group** (proven, live) and reuses `auto-create-invoice` + `/pay/:token` **unchanged**.
- The invoice branch of the webhook resolves the recipient via `invoice.academy_profile_id` — sidestepping the trainer `maybeSingle` routing entirely.

→ **Recommend the invoice path.** (Documented alternative kept for Codex to weigh.)

---

## 3. Concrete changes

**A-1. Token-gated single-claim invoice mint** — a new edge fn `create-rebook-invoice-public` (or generalize `create-group-rebook-invoice` to accept a non-group claim). Token-gated exactly like the group fn: verify `claim_token` → service role → accept claim → mint full-price invoice keyed to `player_id ?? guest_player_id` → return `publicToken`. **No auth header.**

**A-2. Full price — structural, not a flag (F4).** Mint over **only the claimant's own booking rows** (a single `player_id`/`guest_player_id` identity → `auto-create-invoice`'s auto-split can't fire since it needs >1 distinct player); those rows carry no pre-split `payment_amount`. Add a test that a `split_payment` slot with *other* participants still mints a full-price rebook invoice. Optionally add an explicit `forceFullPrice` flag to `auto-create-invoice` as a structural backstop for any future mixed-batch path.

**A-3. Client routing** — in `acceptClaimAndStartPayment`, route the upfront single-claim case (logged-in **and** logged-out) to A-1 → `/pay/:token`, replacing the `getUser()` gate + `upfront_unavailable` return at [:883-884](src/lib/priorityClaims.ts:883). Uniform no-login path for everyone.

**A-4. Full-cycle scope, server-side by identity (F2).** Derive the scope from the token: gather ALL pending/claimed claims for the same claimant identity (`player_id` **OR** `guest_player_id`) across the target `cyclus_id` — matching the current cycle-scoped fan-out ([priorityClaims.ts:906-912](src/lib/priorityClaims.ts:906)) but by identity, not `eq('player_id')` (null for guests). This can span multiple `rebook_group_id`s in one cycle. Never accept client-supplied booking IDs. Test: two groups in one cycle for the same claimant → one invoice covering all intended bookings.

**A-5. Claim lifecycle — claim at ACCEPT, not via the webhook (F1).** `respond_to_priority_claim` marks the claims `claimed` in step 1 (before the invoice). The webhook's invoice branch marks **bookings** paid only — **do NOT** add a claim writeback there. Document abandoned-after-accept: non-strict = a confirmed-but-unpaid commitment (same as deferred); strict = reset per A-6.

**A-6. Strict-mode server-side cleanup (F3).** When `rebook_strict_mollie`, step 1 creates `payment_pending` TTL holds. If the strict checkout cannot start, the fn cancels the just-minted invoice + bookings and resets the claims to `pending` **server-side** (mirror `create-group-rebook-invoice:157-168`). Never rely on `release_rebook_hold` (auth-owned; guests can't call it).

**A-7. Idempotency — structural double-pay guard.** Add the single-claim equivalent of the group's unique partial index on `invoices.rebook_group_id`: a unique partial index scoping one active (non-cancelled) rebook invoice per (claimant identity, `cyclus_id`), so a concurrent/re-clicked mint hits a DB conflict rather than a read-before-write race, and the fn returns the existing invoice's `publicToken`.

---

## 4. Money-path invariants the design must hold

1. **Charge-org == confirm-org** — the invoice carries `academy_profile_id`; both `create-invoice-payment` and the webhook invoice branch resolve the recipient from it (already symmetric, and F3-safe).
2. **`sum(payment_amount) == invoice.total`** — the webhook amount-match guard; the mint must set the invoice total = full cycle price and distribute `payment_amount` across bookings to the cent.
3. **Full price, never split (F4)** — structural: mint over a single-identity booking batch so the auto-split can't fire (not the `splitAmongPlayers=null` flag alone, which still auto-splits on `split_payment` slots).
4. **Idempotency / no double-charge (F3/A-7)** — a **structural** unique partial index (one active rebook invoice per claimant-identity + `cyclus_id`) backing `auto-create-invoice`'s `overlaps(booking_ids)` dedup, so concurrent re-clicks conflict at the DB rather than racing; the fn returns the existing `publicToken`.
5. **Deferred fallback untouched** — Slice A is the *upfront* no-login path; the deferred (invoice-at-cycle-start) path is not changed here (avoids the double-charge trap the earlier "always full price" work flagged). See §5 for the open owner question on deferred.

---

## 5. Open questions / risks for Codex to scrutinize

- **[SECURITY, HIGH]** The token-gate must mint **only** for the bookings belonging to the verified `claim_token`'s claim/cycle — never accept arbitrary booking UUIDs. Confirm a holder of one claim token cannot mint/charge against another player's bookings. (This is the group fn's model — verify it transfers.)
- **[GUEST EMAIL]** `slot_priority_claims` may not store a guest's email; the invoice + confirmation need a recipient address. Where does the guest email come from for a single-claim guest invoice? (The group path resolves it from the guest row — confirm the single path can too.)
- **[FULL-PRICE SCOPE]** Owner #1 says *every* rebook is full price. Does that include the **deferred** mode (invoice at cycle start), or only the upfront path Slice A builds? If deferred must also be full price, A-2 extends to the deferred minter.
- **[DEFERRED MODE FUTURE]** Given owner #2 (pay at checkout), is the `deferred` payment mode still wanted at all, or should upfront-no-login become the only mode? (Product decision — flag, don't assume.)
- **[STRICT MODE + INVOICE]** The invoice path reserves the seat via a confirmed (not TTL-hold) booking, so `release_rebook_hold` (which requires `auth.uid()`) is moot for it. Confirm the invoice path doesn't create a strict TTL hold a guest can't release.
- **[DOUBLE-PAY GUARD]** Design the single-claim equivalent of the group's `rebook_group_id` unique index (per-claim or per-(player/guest, cyclus)) so concurrent/re-clicked mints can't double-charge.
- **[SPLIT-DETECTION TIMING]** `auto-create-invoice` counts distinct players at mint time; with `splitAmongPlayers=null` this is bypassed, but confirm no path re-introduces a split for a rebook invoice.

---

## 6. Build plan (once the design is blessed)

1. **A-1 + A-4 + A-2 + A-7** — token-gated `create-rebook-invoice-public`: verify `claim_token` → service role → gather the claimant's cyclus-wide claims by identity → accept (claims `claimed`) → mint ONE full-price invoice over only the claimant's bookings → return `publicToken`. Backed by the A-7 unique index.
2. **A-6** — strict-mode server-side cleanup (cancel + reset claims to pending on checkout-start failure).
3. **A-3** — client routing: upfront single claim (logged-in **and** logged-out) → token mint → `/pay/:token`, no `getUser()`.
4. **A-5** — confirm (don't add) the webhook behavior: bookings paid on the invoice branch, claims already `claimed` from accept.
5. ~~A-2 deferred~~ — **DROPPED** (owner: keep deferred as-is with its split). Slice A does not touch the deferred minter.
6. Full gates + **hand the built money path back to Codex** for a final verify (mirrors F3/F5).

**Required tests before merge** (Codex's set):
1. Guest-keyed single claim → public fn → invoice with `guest_player_id` → `publicToken`.
2. Logged-out registered-player claim works with no `getUser()`.
3. The public fn cannot invoice arbitrary booking IDs or another claimant's bookings (security).
4. Full-cycle scope: two same-claimant rebook groups in one cycle → one invoice covering all intended bookings.
5. Split-payment slot with other participants → still a full-price rebook invoice for the claimant.
6. Double-click/retry returns the same active invoice / dedupes — no second payable invoice.
7. Concurrent double-click is **structurally** safe (A-7 index), not just read-before-write safe.
8. Strict cycle + no checkout → cancels invoice/bookings + resets claims to pending.
9. Paid webhook path → bookings paid/confirmed + claims in the intended final state.
10. Guest recipient email resolves from guest/linked identity; invoice email can send.

**Verification bar:** the money-path adversarial workflow (strand-hunter + security + completeness) plus the tests above must pass before merge.
