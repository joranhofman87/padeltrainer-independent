# Codex Review For Claude — Slice A No-Login Full-Cycle Rebook Payment

Date: 2026-07-01  
Repo: `joranhofman87/padeltrainer-independent`  
Local audit path: `/Users/tom/Cursor/padeltrainer`  
Reviewed PR: `#311` / branch `docs/slice-a-design` / commit `fb8ca247`  
Reviewed design doc: `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md`

## Mode

Codex ran this as a no-code-change audit.

No product code was changed. No migrations were applied. No edge functions were deployed. No live payments, emails, or side-effecting flows were invoked. This file is an audit handoff artifact for Claude.

## Bottom Line

The proposed architecture is directionally good: a token-gated invoice mint that sends logged-out players to `/pay/:token` is the right shape and reuses a lot of hardened payment infrastructure.

Do not implement the design exactly as written yet. It contains several false or ambiguous premises around claim lifecycle, full-cycle scope, strict-mode holds, and full-price enforcement. These need to be corrected in the design and covered by tests before coding the money path.

Verdict: **approve the approach, request changes to the design before implementation.**

## Critical Findings

| ID | Severity | Finding | Evidence | Required Claude Action |
|---|---:|---|---|---|
| F1 | P0 | The design says the webhook needs zero changes and already marks `slot_priority_claims` as `claimed`, but current invoice payments do not update priority claims. | Design says this at `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md:22` and `:32`. Current invoice branch marks invoice paid and linked bookings paid/confirmed in `supabase/functions/mollie-webhook/index.ts:353-600`, especially booking writeback at `:526`. The priority-claim update exists only in the direct booking-payment branch at `supabase/functions/mollie-webhook/index.ts:742-759`. | Pick and document the lifecycle explicitly. Option A: accept before invoice, so claims are already `claimed`; then remove the false webhook assertion and test abandoned-payment behavior. Option B: claim only after payment; then add invoice-branch claim writeback for invoice `booking_ids`. Do not leave this ambiguous. |
| F2 | P1 | “Full cycle” scope is under-specified and can become a money bug. | Current client intentionally pays all of the claimant’s claims across the target `cyclus_id`, not only one `rebook_group_id`: `src/lib/priorityClaims.ts:906-912`. The design says “one claim’s slots” and also says gather by claim / `rebook_group_id` / `cyclus_id`: `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md:34` and `:54`. | Define the server-side scope. Recommended if owner means “full cycle”: token claim -> target `cyclus_id` -> all pending/claimed claims for the same claimant identity across that cyclus, possibly across multiple `rebook_group_id`s. Never accept client-provided booking IDs. Add a test with two groups in the same cycle. |
| F3 | P1 | Strict-mode behavior in the design is incorrect. `respond_to_priority_claim` can create `payment_pending` TTL holds, not confirmed bookings. | Strict accept inserts `status = 'payment_pending'` and `hold_expires_at = now() + 15 minutes` when cycle setting `rebook_strict_mollie` is true: `supabase/migrations/20260703150000_rebook_strict_accept_and_release.sql:101-107` and `:164-170`. The design says strict release is moot because invoice path reserves confirmed bookings: `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md:76`. Group invoice code handles this by aborting and resetting on checkout failure: `supabase/functions/create-group-rebook-invoice/index.ts:157-168`. | The new public single-claim invoice function must implement group-style strict cleanup server-side: if strict and checkout cannot start, cancel the invoice/bookings and reset claims to pending. Do not rely on `release_rebook_hold`, because logged-out guests cannot call the auth-owned release path. |
| F4 | P2 | `splitAmongPlayers = null` is not by itself a hard “force full price” flag. | `auto-create-invoice` normalizes `body.splitAmongPlayers || null`, then if falsy and the slot has `split_payment === true`, it can auto-detect a split from distinct players in the booking batch: `supabase/functions/auto-create-invoice/index.ts:34` and `:122-128`. Unit price also uses `payment_amount` first when present: `supabase/functions/_shared/invoice-split-pricing.ts:23-33`. | Make full-price enforcement structural. The safest path is to pass only this claimant’s booking rows created by `respond_to_priority_claim`, which normally have no pre-split `payment_amount`, and add tests proving split-payment slots with other participants still mint a full-price rebook invoice. If future paths can include mixed-player bookings, add an explicit force-full-price mode rather than relying on `null`. |

## Non-Blocking Observation

`get-public-invoice` resolves guest email via `get_invoice_recipient_identity` but does not pass `_academy_profile_id`, so academy-scoped billing-email overrides are not applied to the public invoice page display: `supabase/functions/get-public-invoice/index.ts:88-99`. `send-invoice-email` does pass `_academy_profile_id`, so actual invoice email delivery uses the stronger path: `supabase/functions/send-invoice-email/index.ts:117-122`.

This is not a blocker for Slice A, but Claude can fix it opportunistically if already touching public invoice recipient display.

## Confirmed Premises

These claims in the design checked out:

1. PR `#311` is docs-only: only `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md` changed.
2. The current single rebook upfront path requires auth: `src/lib/priorityClaims.ts:883-884`.
3. `create-mollie-payment` rejects guest-keyed bookings because it requires every booking’s `player_id` to match the caller profile: `supabase/functions/create-mollie-payment/index.ts:230-235`.
4. `create-rebook-invoice` is also logged-in-player scoped and rejects bookings not owned by the caller profile: `supabase/functions/create-rebook-invoice/index.ts:31-59`.
5. The existing group rebook invoice path is token-gated/no-login and guest-aware: `supabase/functions/create-group-rebook-invoice/index.ts:58-68`, `:94-108`, `:119-128`.
6. `/pay/:token` is no-login:
   - `get-public-invoice` uses service role and requires only `publicToken`: `supabase/functions/get-public-invoice/index.ts:17-34`.
   - `create-invoice-payment` requires `publicToken`, not an authenticated user: `supabase/functions/create-invoice-payment/index.ts:126-142`.
   - Supabase config sets `verify_jwt = false` for `get-public-invoice`, `create-invoice-payment`, and `create-group-rebook-invoice`: `supabase/config.toml:181-191`.
7. The invoice payment branch has good amount and cancelled-invoice guards:
   - amount check: `supabase/functions/mollie-webhook/index.ts:388-410`
   - cancelled invoice guard: `supabase/functions/mollie-webhook/index.ts:412-425`
   - atomic paid transition: `supabase/functions/mollie-webhook/index.ts:427-438`
8. Charge org symmetry for invoice payments is strong:
   - `create-invoice-payment` resolves academy invoices via `invoice.academy_profile_id`: `supabase/functions/create-invoice-payment/index.ts:187-224`.
   - webhook resolves connected account from invoice lookup if booking lookup does not resolve: `supabase/functions/mollie-webhook/index.ts:257-296`.

## What Claude Should Change In The Design Before Coding

Update `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md` before implementation.

Required edits:

1. Replace “webhook needs zero changes” with a precise claim lifecycle.
2. Define whether the new function claims before payment or only after payment.
3. Define “full cycle” in SQL/query terms.
4. Define strict-mode behavior for logged-out players and guests.
5. Replace “`splitAmongPlayers = null` forces full price” with a verified mechanism.
6. Define the idempotency guard and its structural backstop.

Recommended implementation direction:

1. Add a new token-gated edge function, e.g. `create-rebook-invoice-public`.
2. Verify `claim_token` first, then use service role for all writes.
3. Derive all booking/claim scope server-side from the token. Never accept arbitrary booking IDs from the client.
4. For owner “full cycle”, gather all same-claimant claims under the same target `cyclus_id`, not only the one clicked claim.
5. Use `respond_to_priority_claim` to create booking rows, but treat its strict return carefully.
6. Mint one full-price sent invoice via `auto-create-invoice`.
7. Return `publicToken` and optional `checkoutUrl`.
8. Route both logged-in and logged-out single rebook upfront flows through this public token path.
9. If strict and checkout cannot start, reset all created state server-side before returning failure.
10. Add or verify claim writeback according to the chosen lifecycle.

## Required Tests Before Merge

Add characterization/invariant tests. Minimum recommended set:

1. Guest-keyed single claim -> public function -> invoice with `guest_player_id` -> `publicToken` returned.
2. Logged-out registered-player claim works without `supabase.auth.getUser()`.
3. Public function cannot invoice arbitrary booking IDs or another claimant’s bookings.
4. Full-cycle scope: one token in a cycle with two same-player rebook groups produces one invoice covering all intended cycle bookings.
5. Split-payment slot with other participants still produces full-price rebook invoice for the claimant.
6. Double-click/retry returns the same active invoice or safely dedupes; no second payable invoice is minted.
7. Concurrent double-click/retry is structurally safe, not only read-before-write safe.
8. Strict cycle + no checkout available cancels invoice/bookings and resets claims to pending.
9. Paid invoice webhook path leaves bookings paid/confirmed and the priority claims in the intended final state.
10. Guest recipient email is resolved from guest/linked profile identity and invoice email can be sent.

## Validation Codex Ran

Safe local checks only:

```bash
npm run lint
npm run typecheck:baseline
npm test
npm run test:edge
npm run build
```

Results:

1. `npm run lint`: passed.
2. `npm run typecheck:baseline`: passed. Output reported 91 pre-existing baseline errors, baseline 107, and 5 baseline signatures that could optionally be shrunk.
3. `npm run test:edge`: passed, 51 tests.
4. `npm run build`: passed.
5. `npm test`: first run failed with PGlite hook timeouts while multiple heavy commands were running in parallel. Standalone rerun passed: 281 test files, 2080 tests.

## Worktree Sanity

Codex did not modify tracked product files during the audit. At the end of the audit, `git diff --name-only` and `git diff --name-only --staged` were empty.

There were pre-existing untracked audit docs in the worktree before this handoff file was added:

```text
docs/COMPONENT_REUSE_AUDIT.md
docs/audits/INDEPENDENT_ARCHITECTURE_SCALABILITY_AUDIT_2026-06-28.md
docs/audits/INDEPENDENT_AUDIT_WORKLOG.md
```

## Claude Self-Check Before Marking Done

Before Claude marks the next implementation complete, it should explicitly answer:

1. Did I update the design to remove the false webhook/claim-writeback premise?
2. Did I define and test exact full-cycle scope?
3. Did I prove guest/no-login works without auth?
4. Did I prove strict cleanup works for logged-out users?
5. Did I prove full-price behavior on split-payment slots?
6. Did I prove double-click/concurrent retry cannot create a second payable invoice?
7. Did I run lint, typecheck baseline, tests, edge tests, and build?
8. Did I avoid deploys, migrations, test emails, and live payments unless explicitly requested in a separate deploy prompt?

