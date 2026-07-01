# Slice A — no-login, full-cycle rebook payment (design for review)

**Date:** 2026-07-01
**Status:** DESIGN ONLY — hand to Codex for a money-path second-look before building.
**Owner decisions this implements:** #1 (every rebook is full price) + #2 (email → checkout → pay, **no login**).
**Codex finding it closes:** P1 (upfront individual rebook has no working payment path for logged-out/guest players).

Grounded by a 6-area read-only map of the payment internals (2026-07-01).

---

## 1. The gap, precisely

The owner's flow is: click **YES** on a rebook invite → go to **checkout** → **pay the full cycle**, **no login**. Today only *part* of that works:

| Path | Token-gated / no-login? | Evidence |
|---|---|---|
| **Group** rebook (captain pays for the whole group) | ✅ **Already no-login** | `create-group-rebook-invoice` is token-gated: runs as service role after verifying `claim_token`, no auth header, treats `guest_player_id` like `player_id`, mints one full-price invoice → returns `checkoutUrl`/`publicToken` |
| **Single** (non-group) rebook | ❌ **Login required** | `acceptClaimAndStartPayment` calls `getUser()` at [priorityClaims.ts:883](src/lib/priorityClaims.ts:883); a claimant with no `auth.uid()` returns `upfront_unavailable`. Downstream `create-mollie-payment` ([:231-235](supabase/functions/create-mollie-payment/index.ts:231)) and `create-rebook-invoice` ([:31-59](supabase/functions/create-rebook-invoice/index.ts:31)) each require `booking.player_id === caller.profile.id` — guest-keyed bookings (`player_id=null`) are rejected |
| **`/pay/:token`** checkout + confirm | ✅ **Fully no-login** | `PublicInvoicePay` → `get-public-invoice` (service role, no `verify_jwt`) → `create-invoice-payment` (token-based, no JWT) → `mollie-webhook` invoice branch (amount-match, marks paid, flips `booking_ids` to confirmed/paid, resolves recipient via `invoice.academy_profile_id`) |

**So the fix is narrow:** give the **single claim** the same token-gated invoice mint the **group** path already has. The `/pay/:token` stack and the webhook need **zero changes** — they already run no-login and already write back.

---

## 2. Chosen approach — token-gated invoice → `/pay/:token` (reuse the group pattern)

**YES on a single claim (no login) →** a token-gated edge function that, given the `claim_token`:
1. Accepts the claim via `respond_to_priority_claim` (already anon-callable; preserves `guest_player_id`), creating the cycle's booking rows.
2. Mints **one full-price invoice** for that claim's cycle bookings via `auto-create-invoice` (already guest-aware — keys `player_id` **or** `guest_player_id`), with **`splitAmongPlayers = null` → full price** (owner #1).
3. Returns the invoice `public_token`.
4. Client redirects to **`/pay/:token`** → existing `create-invoice-payment` → `mollie-webhook` confirms, marks bookings paid/confirmed and the `slot_priority_claims` → `claimed`.

This mirrors `create-group-rebook-invoice` almost exactly; the only structural difference is scope (one claim's slots instead of the group's) and the double-pay guard.

### Why this over the alternative (guest pay-first holds)
`book_guest_cyclus_for_payment` + `create-guest-cyclus-payment` (the public-booking stack) could also work — mint `payment_pending` TTL holds → Mollie → webhook. But:
- It commits TTL holds *before* payment and needs new claim-linking + a group-roster-after-pay story (rosters don't expire, holds do).
- The invoice path **already exists for the group** (proven, live) and reuses `auto-create-invoice` + `/pay/:token` **unchanged**.
- The invoice branch of the webhook resolves the recipient via `invoice.academy_profile_id` — sidestepping the trainer `maybeSingle` routing entirely.

→ **Recommend the invoice path.** (Documented alternative kept for Codex to weigh.)

---

## 3. Concrete changes

**A-1. Token-gated single-claim invoice mint** — a new edge fn `create-rebook-invoice-public` (or generalize `create-group-rebook-invoice` to accept a non-group claim). Token-gated exactly like the group fn: verify `claim_token` → service role → accept claim → mint full-price invoice keyed to `player_id ?? guest_player_id` → return `publicToken`. **No auth header.**

**A-2. Full price (owner #1)** — mint with `splitAmongPlayers = null` so the rebook invoice is the full cycle price, never ÷headcount. This neutralizes `auto-create-invoice`'s split auto-detection for the rebook path. Fold the same into the deferred path if the owner wants *all* individual rebooks full price.

**A-3. Client routing** — in `acceptClaimAndStartPayment`, route the upfront single-claim case (logged-in **and** logged-out) to A-1 → `/pay/:token`, replacing the `getUser()` gate + `upfront_unavailable` return at [:883-884](src/lib/priorityClaims.ts:883). Uniform no-login path for everyone.

**A-4. Sibling fan-out by claim, not player** — the multi-slot fan-out at [:915-920](src/lib/priorityClaims.ts:915) uses `eq('player_id', playerId)`, which returns nothing for a guest. The token-gated mint must gather the full cycle's slots from the **claim / `rebook_group_id` / `cyclus_id`**, so a guest is charged the whole cycle, not one slot.

**A-5. Writeback (verify, likely no change)** — confirm `mollie-webhook`'s invoice branch flips the invoice's `booking_ids` to confirmed/paid **and** marks the matching `slot_priority_claims` → `claimed`. If the claim-status flip only happens on the booking path, add it to the invoice branch.

---

## 4. Money-path invariants the design must hold

1. **Charge-org == confirm-org** — the invoice carries `academy_profile_id`; both `create-invoice-payment` and the webhook invoice branch resolve the recipient from it (already symmetric, and F3-safe).
2. **`sum(payment_amount) == invoice.total`** — the webhook amount-match guard; the mint must set the invoice total = full cycle price and distribute `payment_amount` across bookings to the cent.
3. **Full price, never split** — `splitAmongPlayers = null` for rebook mints (owner #1).
4. **Idempotency / no double-charge** — reuse `auto-create-invoice`'s dedup (`overlaps(booking_ids)`) **and** add a single-claim double-pay guard equivalent to the group's unique partial index on `invoices.rebook_group_id` (e.g. a per-claim/per-booking guard), so a re-click never mints a second invoice.
5. **Deferred fallback untouched** — Slice A is the *upfront* no-login path; the deferred (invoice-at-cycle-start) path is not changed here (avoids the double-charge trap the earlier "always full price" work flagged).

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

1. **A-1 + A-4** — token-gated single-claim full-price invoice mint (edge fn + the claim-scoped slot gather). Adversarial money-path review + PGlite test that a guest-keyed claim mints a full-price invoice tied to `guest_player_id` and flows through `/pay/:token`.
2. **A-3** — client routing: upfront single claim → token mint → `/pay/:token`, no `getUser()`.
3. **A-5** — verify/complete the webhook claim-status writeback for invoice payments.
4. **A-2 (deferred, if owner wants)** — full-price the deferred minter too.
5. Full gates + **hand the built money path back to Codex** for a final verify (mirrors the F3/F5 process).

**Verification bar:** the money-path adversarial workflow (strand-hunter + security + completeness) must pass, plus a PGlite test proving a **guest** claim → full-price invoice → paid → bookings confirmed + claim `claimed`, with no double-charge on re-click.
