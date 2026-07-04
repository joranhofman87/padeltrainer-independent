# Rebooking feature audit — 2026-07-05

**Scope:** the full rebooking loop — academy new-round setup (`AcademyNewRoundWizard` / `RebookCohortWizard` → `bulk-rebook-cycle`) → priority-claim invites + reminders → player claim (`/PriorityClaim`, rules consent, whole-group captain model) → capacity holds → payment (deferred invoice / Mollie pay-first / group invoice → `mollie-webhook` group-flip) → confirmation emails → expiry crons → academy monitoring (`AcademyRebookManage`).

**Method:** read-only, deeply adversarial. 72 agents across 5 phases (ground-truth state-machine map + deploy-drift checklist → per-subsystem correctness finders → 6 attacker lenses → UX walkthroughs → 2 independent skeptics *per serious finding* whose default was to refute). 46 raw findings → 29 serious → verified survivors below. The headline money finding was additionally re-verified by hand against live code (it contradicts a prior "full price already correct" note — see P0-1).

**Reviewed at:** `main` @ `82fe71c4`. No code was changed — this is an audit.

---

## Verdict

| Question | Answer |
|---|---|
| **Does it work?** | **Mostly — with one silent money leak and one always-wrong monitoring view.** The common non-split-payment path is sound. But upfront rebooks on `split_payment` cycles **undercharge by the court capacity factor** (P0-1), and the academy's own "who paid?" view is **always wrong** because it reads invoices by the wrong key (P1-1). A deploy-drift landmine can blank the whole management view (P1-2). |
| **Is it easy to use?** | **Adequate, with real gaps.** The claim page hides the price on court-priced slots (P1-3), never shows the captain who they're about to pay for before they commit (P2-6), shows times in the wrong timezone vs the email (P2-7), and the emails are Dutch-only (P2-9). |
| **Can people abuse it?** | **No catastrophic abuse — the money/auth core held up.** Under adversarial refutation the payment linchpin (webhook auth, group-flip idempotency, no-resurrect-cancelled), the capacity advisory locks, and the invoice dedup indexes all survived. Real but bounded issues: a cross-tenant invoice-pollution IDOR (P2-1), cross-tenant guest injection (P2-2), and server-side consent not enforced (P2-3). There is **no "pay nothing, book everything"** hole — the undercharge is a pricing bug, not an auth bypass. |

**Bottom line:** safe to keep running, but **P0-1 is losing real money today on any academy that uses shared-court (`split_payment`) pricing with upfront rebooking**, and P1-1/P1-2 mean the academy can't actually see the truth of who paid. Fix those three first.

---

## P0 — fix now

### P0-1 · Upfront rebook invoices undercharge to 1/capacity on `split_payment` cycles
`supabase/functions/create-group-rebook-invoice/index.ts:105` · `create-rebook-invoice-public/index.ts:150` · root cause `auto-create-invoice/index.ts:129`

**What.** Both upfront-rebook invoice minters call `auto-create-invoice` with `{ bookingIds }` and *deliberately omit* `splitAmongPlayers`, on the stated assumption (in a code comment) that *"single-player batch so the split auto-detect cannot fire → full court price."* **That assumption is false.** `auto-create-invoice:129` fires the split on the slot flag, not the batch:

```ts
if (!splitAmongPlayers && slot.split_payment === true) {
  const divisor = resolveSplitDivisorFromSlots(...); // = Math.max(max_participants) = court capacity, e.g. 4
  if (divisor > 1) splitAmongPlayers = divisor;
}
```

So on a `split_payment = true` cycle (capacity 4, €40/session), the captain's "whole court" invoice is minted at **€10/session**, not €40. The captain pays 1/4; the other 3 seats are then attached as covered/paid bookings for free. The whole cohort is collected at ~1/capacity of one court fee.

**Why it's real / not caught.** Verified by hand against live code. The auto-detect is capacity-based by design (a correct "G5" decision for the *normal* deferred path, where each player gets their own 1/N invoice and the sum = full court). It's wrong only for the *single-invoice-for-the-whole-court* rebook path. The prior "full price already correct" note was about *not flipping the `split_payment` flag* — correct, but it missed that the mint path auto-divides even without flipping. The one regression test (`rebookPublicGatherScope.pglite.test.ts`) asserts *which* bookings are gathered but never asserts the *amount*, giving false confidence.

**Blast radius.** Only `split_payment = true` cycles with **upfront** rebooking. Non-split cycles and the deferred path are unaffected. But shared-court pricing is common, so this is likely a live leak.

**Fix.** Pass `splitAmongPlayers: 1` (or add a `forceFullPrice` flag honored by `auto-create-invoice`) in both `create-group-rebook-invoice` and `create-rebook-invoice-public`, so the whole-court mint bills full price regardless of the slot flag. **Add a PGlite test that asserts the minted unit price = full `price_per_session`, not `price_per_session / capacity`.**

---

## P1 — fix soon

### P1-1 · The academy's "who paid?" view is always wrong (`invoices.cycle_id` is never set on rebook invoices)
`src/lib/rebookManage.ts:126`

`getCycleRebookStatus` derives every player's paid/unpaid badge and the paid/unpaid counts from `invoices` filtered by `.eq('cycle_id', cycleId)`. **No rebook invoice ever sets `cycle_id`** — single-claim invoices are tagged `rebook_cyclus_id`, group invoices `rebook_group_id`, and all are booking-based. So `AcademyRebookManage` shows **every upfront-rebooked player as unpaid/uninvoiced**, always. The academy literally cannot see who has paid.

**Fix.** Resolve paid/invoiced by the keys the invoices actually carry: `rebook_cyclus_id = cycleId` (single) + `rebook_group_id` for the round's groups, or via the invoice→`booking_ids` overlap with the claims' bookings.

### P1-2 · Management view silently shows empty if `reminded_at` migration isn't deployed
`src/lib/rebookManage.ts:122`

`getCycleRebookStatus` selects `reminded_at` (added by owner-deploy-pending migration `20260625130000`) and destructures `data` without checking `error`. If that migration isn't live, the select 400s and the **entire rebook management view shows empty** — no rows, no error. `getMyPendingPriorityClaims` already has the correct PGRST-error fallback pattern; this path doesn't.

**Fix.** Add the same PGRST fallback (retry the select without `reminded_at`, default `lastRemindedAt = null`), matching `getMyPendingPriorityClaims`.

### P1-3 · Claim page hides the price entirely on court-priced slots
`src/pages/PriorityClaim.tsx:341`

Every price/payment element on the claim card is gated on `data.slot.price_per_session`. A slot priced by `total_price` (with `price_per_session` null) renders **no price, no total, no pay button context** — the player is asked to commit/pay with zero price shown.

**Fix.** When `price_per_session` is null but `total_price` is set, render the term total from `total_price`. Never show a payable rebook with no price.

### P1-4 · Rules-consent gate is bypassed on the in-app dashboard "Keep" path
`src/components/dashboard/PlayerRebookCard.tsx:39`

The dashboard "Keep my spot" button accepts the claim without ever rendering the mandatory rebooking-rules consent checkbox. A player who keeps their spot from the logged-in dashboard (instead of the email link) commits **without consenting to the rules** the academy set. (Compounds with P2-3 — consent is client-side only, so nothing server-side catches it.)

**Fix.** Surface the consent in `PlayerRebookCard` before Keep, or (better, see P2-3) enforce consent server-side in the accept path for cycles that have `rebook_rules` set.

---

## P2 — should fix

### P2-1 · `rebook_group_manage` IDOR: a captain can graft booking_ids onto ANY paid invoice
`supabase/migrations/20260705100000_rebook_group_count_live_holds.sql:369` (also `20260626110000:261`)

The anon-callable, SECURITY DEFINER `rebook_group_manage` appends the caller's new booking IDs onto a **client-supplied `_invoice_id`** guarded only by `WHERE id = _invoice_id AND status = 'paid'` — **no check that the invoice belongs to the caller's group/academy.** A holder of any valid *paid* group token can inject their booking IDs into any paid invoice in the system (cross-tenant integrity pollution). Impact is corruption, not direct theft (injected bookings don't move money), but it dirties another tenant's invoice `booking_ids`.

**Fix.** Add `AND rebook_group_id = v_group` to the step-4 UPDATE (the group invoice is already tagged with `rebook_group_id`), or resolve the invoice id server-side from the group instead of trusting the client.

### P2-2 · Group RPCs accept cross-tenant `guest_player` IDs (no academy scoping)
`20260705100000...sql:329` (`rebook_group_manage`) + `rebook_group_apply`

Both group RPCs insert bookings/claims for every UUID in the caller-supplied `_new_guest_ids` without verifying those `guest_players` belong to the group's academy. A captain can attach another academy's guest onto their own slots. **Fix.** Filter `_new_guest_ids` to guests whose `guest_players.academy_profile_id` matches the group's academy (derived from `c.slot_id → availability_slots.academy_profile_id`).

### P2-3 · Rules-consent is client-side only — accept/pay RPCs never require `rules_accepted_at`
`supabase/migrations/20260704140000_rebook_rules_consent.sql:20`

Consent is enforced only by a disabled button in the React `RebookRulesField`. `respond_to_priority_claim` (accept), `rebook_group_apply`, and `create-rebook-invoice-public` never check `rules_accepted_at`. A player calling the RPC directly (or via P1-4's dashboard path) commits without consenting. If the rules are a legal/commercial gate, this defeats it. **Fix.** Enforce consent server-side where the money-path decision is made, for cycles that have `rebook_rules` set.

### P2-4 · Released strict hold + late payment → charged, no seat, manual refund
`supabase/migrations/20260703150000_rebook_strict_accept_and_release.sql:252`

`release_expired_rebook_holds` sets `status='cancelled'` but leaves `payment_status='pending'`. If a player completes Mollie payment just after the 15-min hold TTL expires, the `paid` webhook lands on a cancelled booking → the no-resurrect guard refuses to confirm → Slack "manual refund" alert. Player is charged, loses the seat. iDEAL/bank redirects can exceed 15 min. **Fix.** Lengthen the strict TTL beyond real payment latency, or have the release check for an in-flight Mollie payment before cancelling, or have the webhook re-book (not just alert) when a paid payment lands on a just-released hold.

### P2-5 · New round can be created with null/€0 price or zero sessions, no blocking warning
`src/components/cycles/AcademyNewRoundWizard.tsx:188`

Submit gates only on `review.players > 0` + the no-email ack — not on a non-null price or non-zero session count. A source cyclus with no price + a blank price field produces a live round with null-priced slots (players see no price, `auto-create-invoice` skips with `missing_price_data`, nobody is billed) with no signal to the academy. **Fix.** Block submit (or hard-warn) when the effective price is empty/0 or any group's session count is 0.

### P2 · UX cluster (real friction, no money/security risk)
- **P2-6** Whole-group readout not shown before committing — the captain can't see which teammates they're about to re-book/pay for until *after* clicking. `PriorityClaim.tsx:439`. Fix: compact roster preview (first names + count) on the card.
- **P2-7** Times/deadline shown in **browser** timezone on the claim page but **academy** timezone in the email — a player in another tz sees two different times. `PriorityClaim.tsx:332`. Fix: format the page in the academy timezone.
- **P2-8** Rebooked/added group members get a confirmation email with **no self-service decline link** — only "contact the academy," despite each holding a claim token. `send-rebook-group-confirmation/index.ts:220`.
- **P2-9** Invitation email + claim page are **Dutch-only** regardless of recipient/academy language (`buildClaimUrl` always defaults `nl`). `_shared/priority-claim-invite.ts:34`. en/nl translations already ship.
- **P2-10** "Clicked Yes but never paid" intent is captured server-side (`response_intent`) but **never surfaced** in the management view — the academy can't distinguish "committed, unpaid" from "never opened." `rebookManage.ts:122`.
- **P2-11** In-app dashboard card offers **no whole-group rebook** — a captain arriving via the dashboard can only book themselves, not the group. `PlayerRebookCard.tsx:168`.

---

## P3 — minor / hardening (16 findings, summarized)

Abuse (bounded): guest-mint rate-limit is per-token not per-academy (slow-drip guest creation + welcome-email to attacker addresses); `create_rebook_group_guest` allows ~40 guests/hour/token; `send-rebook-group-confirmation` throttle is a non-atomic read-modify-write (concurrency-bypassable email amplifier); `create-rebook-invoice-public` accepts all pending claims for a token identity with no per-token rate limit; `get_priority_claim_by_token` returns player email to any token holder; booking-branch amount check is skipped when `expectedSum == 0` (latent guard bypass on null-amount bookings). Correctness/money: strict hold TTL race (P2-4's smaller sibling); authed `create-rebook-invoice` fallback has no unique-index dedup (concurrent double-click → two payable invoices); strict `payment_pending` holds don't enter the M-17 unique index (deduped only by row-lock); partial-group accept strands per-week claims `pending` when some sessions are full; per-member rules consent not obtained for group-booked members; cohort auto-preview omits weeks/holidays so the headline count can diverge. UX: deferred "keep everyone" has no per-player cost breakdown; legacy authed upfront accept returns to generic `/app/booking-success`.

Full structured detail (evidence + repro + fix per item) is in the workflow output; can be expanded on request.

---

## What held up under adversarial testing (reassurances)

These were probed hard and **survived refutation** — they are *not* broken:

- **The payment linchpin.** `mollie-webhook` flips all `booking_ids` to paid atomically for one payment, never resurrects a cancelled booking, never downgrades an already-paid one, and routes paid-on-cancelled to a manual-refund Slack alert. Webhook auth + idempotency held.
- **No "pay once, book many" auth hole.** The group model is *designed* as pay-once-cover-many; the only leak is the *pricing* undercharge (P0-1), not an auth bypass. You cannot get bookings flipped to paid without a real completed payment.
- **Capacity races.** Accept is serialized under `pg_advisory_xact_lock(slot_id)` and counts live `payment_pending` holds (migration `20260705100000`). The overbook-race and double-claim attack attempts were refuted.
- **Invoice double-charge.** The unique partial indexes (one active invoice per group / per claimant+cyclus) plus the M-17 set block the double-pay-on-retry vectors that were attempted.
- **Cron single-point-of-failure** (initially flagged P1) was **refuted** — abandoned strict holds have backstops (the webhook reset on failed payment + lazy reclaim), so a stalled release cron degrades rather than strands.

---

## Deploy-drift checklist (many rebook migrations/edge-fns are owner-deployed)

Frontend auto-deploys (Vercel); **DB migrations + edge fns are applied manually by the owner** and may lag. The FE is mostly written to degrade gracefully, but verify these are **live in prod**:

| Component | If NOT deployed | Severity |
|---|---|---|
| `20260625130000` (`reminded_at`) | **Management view shows EMPTY** (P1-2 — no fallback) | ⚠️ landmine |
| `create-rebook-invoice-public` | Upfront single claim silently degrades to deferred/authed accept | graceful |
| `create-group-rebook-invoice` | Upfront group-pay inert; error state on the claim page | graceful |
| `rebook_group_apply/manage/get_by_token/create_guest` (`20260626*`, `20260705100000/110000`) | Whole-group captain model inert; falls back to solo card | graceful |
| `get_my_pending_priority_claims` (`20260703120000`) | Guest-keyed claims invisible on dashboard | graceful |
| `rebook_strict_hold_capacity` + `..._accept_and_release` (`20260703140000/150000`) | Accepts create **confirmed** bookings instead of holds — strict pay-first is off | **behavior change** |
| `schedule_release_rebook_holds_cron` (`20260703160000`) + `expire_lapsed_priority_claims_cron` (`20260704200000`) | Holds/claims not auto-reclaimed (lazy backstops still apply) | degrade |
| `academy_rebook_rules` + `rebook_rules_consent` (`20260704130000/140000`) | Rules feature inert (no gate) | graceful |

**Action:** confirm the prod deploy state of these before trusting "it works" — the answer to "does it work?" partly depends on what's actually live.

---

## Prioritized remediation backlog

1. **P0-1** — force full price in `create-group-rebook-invoice` + `create-rebook-invoice-public` (`splitAmongPlayers: 1`) **+ amount-asserting test.** *(money leak, small fix)*
2. **P1-1** — fix `rebookManage` to read invoices by `rebook_cyclus_id`/`rebook_group_id`/booking overlap. *(academy can't see payments)*
3. **P1-2** — add the `reminded_at` PGRST fallback. *(deploy-drift landmine)*
4. **P1-3** — render `total_price` when `price_per_session` is null on the claim card.
5. **P2-1 / P2-2 / P2-3** — scope `rebook_group_manage` invoice + guest IDs to the group's academy; enforce rules consent server-side. *(one migration + RPC hardening)*
6. **P1-4, P2-4…P2-11** — the consent/UX/hold-TTL cluster.
7. **P3** — hardening batch (rate-limit scoping, dedup on authed fallback, partial-group, i18n emails).

Confirm the **deploy-drift checklist** in parallel — several "is it broken?" answers hinge on what's live in prod.

---

*Audit only — no code changed. Findings ranked by verified severity after adversarial refutation; the P0 was re-verified by hand against live code.*
