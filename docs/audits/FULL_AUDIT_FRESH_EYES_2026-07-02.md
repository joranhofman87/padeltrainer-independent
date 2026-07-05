# Full Fresh-Eyes Audit — padeltrainer

**Date:** 2026-07-02
**Scope:** Entire codebase (React + TS + Vite SPA; Supabase Postgres + RLS + SECURITY DEFINER RPCs + Deno edge functions + pg_cron; Mollie payments via OAuth connected accounts; react-i18next nl/en; multi-tenant academies/trainers/clubs/players/guests).
**Method:** Read-only, fresh-eyes (no prior audit docs, deploy checklists, or git history consulted). 18 finder passes fanned out across dimension × subsystem; every candidate finding was adversarially re-verified by independent skeptic agents prompted to *refute* it (2 skeptics for P0/P1, 1 for P2/P3), then deduplicated and ranked. 45 raw candidates → 6 refuted → 39 survivors → 38 after dedup.
**Result counts:** Round 1: 33 raw / 29 survived / 4 refuted. Round 2 (deep + completeness critic): 12 raw / 10 survived / 2 refuted.

> This report is the only artifact produced. No code, migration, config, or data was changed.

---

## 1. Executive summary

**Verdict: architecturally sound money-path foundations, but NOT safe to scale today.** There is one live, unauthenticated, cross-tenant **P0** that must be fixed before any growth, plus a cluster of genuine **P1** money/tenancy/data-loss defects that will bite under realistic conditions rather than only in theory.

- **Reliability:** Generally guarded on the happy path — the money core uses advisory locks, Mollie idempotency keys, and no-downgrade guards. But those same guards repeatedly protect *data* while silencing the *anomaly*: refunds and chargebacks are ignored with no alert, orphaned holds silently starve capacity, and paid-but-unconfirmed bookings self-heal only when someone visits a page. Several multi-step flows (charge→book, invoice sync loops, forward-invoice) have partial-failure modes with no compensation.
- **Safety (security / tenancy):** The shared edge-auth helper accepts a **forged, unsigned `service_role` JWT** as proof of service-role identity (P0-1). Because nearly all 80 edge functions run `verify_jwt = false` and delegate auth to that helper, an unauthenticated attacker gains full RLS-bypassing privilege on every helper-gated function; `backup-database` (P0-2) turns that into a whole-database exfil. Below that sit real authorization gaps: an ungated `PUBLIC`-execute `swap_slots` RPC (P1-2), unsigned Google-Calendar OAuth state enabling account-linking/token-injection (P1-1), and several anon-reachable RLS leaks of staff emails and PII (P2-1, P2-2, P3-x).
- **Money correctness:** Charge-vs-invoice reconciliation has real gaps in **both** directions — authenticated single-slot bookings under-charge extras but still invoice them (P1-5), guest single-slot bookings double-count extras on the invoice (P2-7). A TOCTOU in `auto-create-invoice` can double-bill a booking on concurrent overlapping sets (P1-6), and `recalculate-invoices` can overwrite a just-paid invoice with no status guard (P2-6).
- **Scalability:** A recurring latent hazard — unbounded PostgREST queries silently truncate at the 1000-row cap on the money path (cycle invoice re-sync, P1-7) and the admin GMV dashboard (P2-16). Currently masked only because the product deliberately avoids mega-cycles; nothing structural prevents a new large cycle.
- **Supporting surfaces:** A structural CI gap (P2-9) — **no type-check or `deno check` on any of the 96 edge functions**, including the 813-line `mollie-webhook` — means a future mistyped/un-imported symbol ships as a runtime error with a green build. Hardening CI is as load-bearing as the point fixes.

**Bottom line:** Fixable in a focused sequence. Land the P0 and the P1 money/tenancy/data-loss items (Slices A–F below) before onboarding more paying tenants or larger cycles.

Severity distribution: **2 × P0, 9 × P1, 16 × P2, 11 × P3** (38 findings). Confidence: 34 CONFIRMED (traced end-to-end), 2 PLAUSIBLE (couldn't fully trace — depends on live prod/PostgREST config), 1 DISPUTED (depends on a Stripe Dashboard setting not observable from source), plus the P0 pair CONFIRMED.

---

## 2. Findings table (P0 → P3)

| ID | Sev | Conf | Area | File:line | One-line |
|----|-----|------|------|-----------|----------|
| P0-1 | P0 | CONFIRMED | security/edge-auth | `supabase/functions/_shared/service-role-auth.ts:95` | Forged unsigned `service_role` JWT is honored as service-role → bypasses all edge-function auth |
| P0-2 | P0 | CONFIRMED | security/edge-auth | `supabase/functions/backup-database/index.ts:27` | `backup-database` exports the whole multi-tenant DB, reachable via the P0-1 bypass |
| P1-1 | P1 | CONFIRMED | security/tenancy | `supabase/functions/google-calendar-callback/index.ts:14` | Unsigned OAuth `state` → attacker binds their Google tokens to a victim's account (CSRF + token injection) |
| P1-2 | P1 | CONFIRMED | tenancy | `supabase/migrations/20260315233209_*.sql:2` | `swap_slots` is SECURITY DEFINER + default PUBLIC EXECUTE, no ownership check → any user overwrites any tenant's slots |
| P1-3 | P1 | CONFIRMED | integrity/data-loss | `supabase/migrations/20260612140000_m17_unique_active_bookings.sql:235` | `merge_guest_players` CASCADE-deletes the source guest's session notes + training-location rows (permanent loss) |
| P1-4 | P1 | CONFIRMED | concurrency/money | `supabase/migrations/20260612140000_m17_unique_active_bookings.sql:44` | `payment_pending` holds excluded from M-17 index → webhook hits 23505, paid booking never confirms (money captured, no seat) |
| P1-5 | P1 | CONFIRMED | money/charge-vs-invoice | `supabase/functions/create-mollie-payment/index.ts:333` | Authenticated single-slot charge omits `extra_costs`, but the auto-invoice bills them and marks paid → extras revenue lost |
| P1-6 | P1 | CONFIRMED | money/concurrency | `supabase/functions/auto-create-invoice/index.ts:531` | TOCTOU overlap-dedup + exact-set-only unique index → concurrent overlapping sets double-bill a booking |
| P1-7 | P1 | CONFIRMED | money/scale | `src/lib/invoiceSync.ts:584` | Cycle invoice re-sync truncates at 1000 bookings → stale invoice amounts after a price change |
| P1-8 | P1 | **DISPUTED** | money/stripe | `supabase/functions/stripe-subscription-webhook/index.ts:126` | Reads removed top-level `invoice.subscription` on basil API → renewals/failures may never record (depends on endpoint API version) |
| P1-9 | P1 | CONFIRMED | money/mis-routing | `supabase/functions/_shared/guest-payment.ts:121` | Academy slot silently routes money to the trainer's PERSONAL Mollie when the academy's Mollie isn't charge-ready |
| P2-1 | P2 | CONFIRMED | rls/tenancy | `supabase/migrations/20260123104639_*.sql:60` | Anon "view open cycles" policy leaks private `notify_admin_emails` staff list + full settings/terms |
| P2-2 | P2 | CONFIRMED | tenancy/PII | `supabase/migrations/20260224171306_*.sql:37` | Academy managers can read a shared trainer's entire `guest_players` roster (name/email/phone) cross-tenant |
| P2-3 | P2 | CONFIRMED | tenancy | `supabase/migrations/20260626110000_rebook_group_manage.sql:262` | `rebook_group_manage` appends bookings onto an arbitrary client-supplied `_invoice_id`, no ownership check |
| P2-4 | P2 | CONFIRMED | money/double-charge | `supabase/functions/create-mollie-payment/index.ts:560` | Transient probe failure on re-pay mints a 2nd open payable checkout without cancelling the 1st |
| P2-5 | P2 | CONFIRMED | money/reversals | `supabase/functions/mollie-webhook/index.ts:616` | Refund/chargeback webhooks silently ignored → reversed payments stay paid/confirmed, no alert |
| P2-6 | P2 | CONFIRMED | money/invoice-integrity | `supabase/functions/recalculate-invoices/index.ts:276` | Recalc UPDATE has no status guard → racing a Mollie payment overwrites a just-paid invoice's totals |
| P2-7 | P2 | CONFIRMED | money/invoice-integrity | `supabase/functions/create-guest-slot-payment/index.ts:161` | Guest single-slot invoice double-counts `extra_costs`: charge = base+extras, invoice = base+2×extras |
| P2-8 | P2 | PLAUSIBLE | money/invoice-split | `supabase/functions/split-invoice/index.ts:365` | `split-invoice` can double-halve an invoice whose bookings already carry Mollie split shares |
| P2-9 | P2 | CONFIRMED | ci/reliability | `.github/workflows/test.yml:119` | No type/`deno check` gate for the 96 edge functions (incl. `mollie-webhook`) → mistyped name ships as runtime error |
| P2-10 | P2 | CONFIRMED | reliability/capacity | `supabase/functions/create-mollie-payment/index.ts:619` | Fresh single-slot booking orphans a capacity-occupying row when Mollie creation fails after insert |
| P2-11 | P2 | CONFIRMED | reliability/email | `supabase/functions/send-schedule-notifications/index.ts:234` | Double-sends on concurrent invocation — no atomic per-row claim before emailing |
| P2-12 | P2 | CONFIRMED | reliability/priority-claims | `supabase/functions/verify-mollie-payment/index.ts:350` | Confirms a paid strict-hold booking without finalizing its claim → on webhook-loss the paid seat can be released |
| P2-13 | P2 | CONFIRMED | frontend/money-display | `src/components/invoices/EditInvoiceDialog.tsx:206` | Price-change detection keys off array index → misfires after a line removal, offers unintended booking resync |
| P2-14 | P2 | CONFIRMED | frontend/cache | `src/components/cycles/CycleDetailView.tsx:516` | Cycle price/roster mutations never invalidate invoice/player caches → stale money shown for up to 60s |
| P2-15 | P2 | CONFIRMED | reliability/integrity | `supabase/functions/_shared/delete-user-data.ts:127` | Deletes `guest_players` before `invoices` under a RESTRICT FK → guest delete silently fails; ordering inverted |
| P2-16 | P2 | CONFIRMED | scale/reliability | `supabase/functions/get-admin-stats/index.ts:78` | Loads entire tables → GMV/counts wrong past 1000 rows; OOM/timeout at very large volume |
| P3-1 | P3 | CONFIRMED | rls | `supabase/migrations/20260612210000_p02_*.sql:8` | `trainer_profiles_safe` leaks non-public (draft) trainers to anon |
| P3-2 | P3 | CONFIRMED | rls | `supabase/migrations/20260628100000_registrations_table.sql:42` | New `registrations` table repeats the anon settings leak (`notify_admin_emails`) once Phase-2 ships |
| P3-3 | P3 | CONFIRMED | tenancy | `supabase/migrations/20260615110120_get_player_locations.sql:14` | `get_player_locations` trusts caller-supplied `guest_player_id` → discloses a foreign guest's venue presence |
| P3-4 | P3 | CONFIRMED | security/open-redirect | `supabase/functions/google-calendar-callback/index.ts:19` | Unsigned `state.redirectUrl` flows into `Response.redirect` → open redirect (phishing) |
| P3-5 | P3 | CONFIRMED | money/invoice-tolerance | `supabase/functions/auto-create-invoice/index.ts:504` | Deduped-invoice paid-match tolerance scales with booking count, no absolute cap → sub-euro drift passes |
| P3-6 | P3 | CONFIRMED | rate-limiting | `supabase/functions/send-email/index.ts:1218` | Public-form limiter keys on spoofable first `X-Forwarded-For` hop → throttle bypass (inbox spam) |
| P3-7 | P3 | CONFIRMED | rate-limiting/concurrency | `supabase/functions/_shared/guest-payment.ts:154` | Rate limiters are non-atomic read-modify-write (TOCTOU) → concurrent burst exceeds the cap |
| P3-8 | P3 | CONFIRMED | reliability/email | `supabase/functions/forward-invoice/index.ts:327` | Partial send releases the `forwarded_at` claim → later resend re-emails recipients that already succeeded |
| P3-9 | P3 | PLAUSIBLE | scale/email | `supabase/functions/notify-followers/index.ts:97` | Unbounded follower fetch → a trainer with >1000 followers silently drops the overflow |
| P3-10 | P3 | CONFIRMED | secrets | `supabase/functions/import-pipeline-data/index.ts:12` | Hardcoded foreign-project Supabase anon JWT committed in source (non-rotatable, ~10-yr validity) |
| P3-11 | P3 | CONFIRMED | i18n | `src/components/cycles/RebookPaymentModeField.tsx:106` | English users see Dutch text for the strict-Mollie rebook toggle (missing EN key) |

---

## 3. Detailed findings

### P0-1 — Forged unsigned `service_role` JWT bypasses all edge-function auth
**`supabase/functions/_shared/service-role-auth.ts:95`** · security/edge-auth · CONFIRMED

**Code path.** `isServiceRoleRequest()` → `isServiceRoleJwtForProject()` → `parseSupabaseJwtClaims()` (`atob`/`JSON.parse`, **no signature check**), reached via `requireServiceRole()` / `requireUser()` / `requireServiceRoleOrAdmin()` in `_shared/auth.ts`. Every function runs `verify_jwt = false` (config.toml).

**Failure scenario.** An unauthenticated attacker reads the public project ref from the SPA bundle / `SUPABASE_URL`, forges `token = base64url({alg:'none'}).base64url({role:'service_role', ref:'<ref>'}).x`, and sends it as **both** `Authorization: Bearer` and `apikey`. `parseSupabaseJwtClaims` decodes the payload with no verification; `isServiceRoleRequest` returns true; `requireUser`/`requireServiceRole` short-circuit to a real RLS-bypassing service-role client (env `SERVICE_ROLE_KEY`) **without ever calling `supabase.auth.getUser`**. Every helper-gated function then executes with full service-role privilege and no ownership check.

**Why guards don't cover it.** The env-key comparison (lines 88–92) does not gate the fallback — when the forged token ≠ the real env key, execution falls through to line 95 which succeeds on claims alone. `ref` is public, not a secret; `verify_jwt = false` means the platform performs no signature check either. The one unverified precondition (whether the hosted gateway independently requires a valid `apikey`, since line 95 needs `bearer == apikey`) is the sole reason a second reviewer initially held PLAUSIBLE — but `mollie-webhook` being invoked by external Mollie servers with no Supabase key demonstrates the gateway does reach these functions unauthenticated.

**Fix direction.** Remove the `isServiceRoleJwtForProject` fallback (lines 95 and 114). Require an exact **constant-time match** against `SUPABASE_SERVICE_ROLE_KEY`, or verify the JWT signature against the project JWT secret before honoring any role claim. Fail closed if the env key is missing rather than accepting claim-only "proof".

---

### P0-2 — `backup-database` exports the entire multi-tenant DB via the P0-1 bypass
**`supabase/functions/backup-database/index.ts:27`** · security/edge-auth · CONFIRMED

**Code path.** `requireServiceRoleOrAdmin(req)` → `requireServiceRole` → `isServiceRoleRequest` (the P0-1 bypass); the handler then `SELECT *`'s 15 tables and writes JSON to the `backups` storage bucket.

**Failure scenario.** Attacker sends the forged service-role JWT (same value in `Authorization` and `apikey`) to `POST /functions/v1/backup-database` with body `{}`. `requireServiceRoleOrAdmin` returns `isServiceRole:true` and the handler serializes `profiles, invoices, bookings, user_roles, guest_players, academy_managers, club_managers, intake_requests` (and more) across **all** tenants to `backups/<timestamp>/*.json`. This is unauthorized full-DB snapshotting at minimum, and complete cross-tenant PII + financial exfiltration if the bucket is readable.

**Why guards don't cover it.** There is no secondary ownership/admin check inside the handler — the entire authorization is the bypassable shared helper. Unlike `admin-reset-password` / `impersonate-user` (which call `supabase.auth.getUser(token)` directly and reject forged tokens), this function trusts only the `isServiceRoleRequest` claims path.

**Fix direction.** Fix the P0-1 root cause. Additionally require a verified admin JWT or a real service-role env-key constant-time match inside `backup-database` (never a claim-only `service_role` token); consider restricting it to cron invocation with the real service key only.

---

### P1-1 — Unsigned Google-Calendar OAuth `state` enables account-linking CSRF + token injection
**`supabase/functions/google-calendar-callback/index.ts:14`** · security/tenancy · CONFIRMED

**Code path.** `google-calendar-auth` mints `state = btoa(JSON.stringify({userId, redirectUrl, timestamp}))` with no HMAC; the callback does `JSON.parse(atob(state))` with zero verification → `upsert user_calendar_connections` on attacker-controlled `stateData.userId` (`onConflict user_id,provider`, service role) → `sync-calendar-event` writes the victim's booking PII to those tokens.

**Failure scenario.** Attacker builds a Google authorize URL (the `client_id` is public) with `state = base64({userId:<victim uuid>, redirectUrl:'/settings/calendar'})` and completes consent with the **attacker's** Google account. The callback exchanges the attacker's `code` and upserts `user_calendar_connections` for the **victim's** `user_id` with the attacker's `refresh_token`/`calendar_id` (overwriting any existing row). Thereafter `sync-calendar-event` writes every session/booking event — client names, times, locations — into the **attacker's** calendar: ongoing cross-account PII exfiltration the victim cannot see.

**Why guards don't cover it.** `google-calendar-auth` authenticates the initiator but only controls the state it mints; the callback (`verify_jwt = false`, reached via Google's server-to-server redirect) performs zero re-authentication and trusts the unsigned state verbatim. `UNIQUE(user_id,provider)` is the `onConflict` key and thus *enables* the overwrite. Service-role upsert bypasses RLS. Only unverified precondition: whether the Google OAuth app is in Testing vs Published mode (a Dashboard config not observable from source).

**Fix direction.** Sign the state with an HMAC over `{userId, redirectUrl, nonce, exp}` using a server secret and verify + expire it in the callback; bind the `nonce` to the initiating session (store server-side) so a stranger cannot forge a state for another user's `userId`. (Fix jointly with P3-4.)

---

### P1-2 — `swap_slots` RPC: SECURITY DEFINER + default PUBLIC EXECUTE, no ownership check
**`supabase/migrations/20260315233209_d179e764-*.sql:2`** · tenancy · CONFIRMED

**Code path.** `public.swap_slots(...)` is SECURITY DEFINER with default PUBLIC EXECUTE (no `REVOKE`/`GRANT`), doing two blind UPDATEs on `availability_slots` keyed only on caller-supplied slot ids; reachable via `supabase.rpc('swap_slots')` in `src/lib/cycleProposalSlots.ts:215`.

**Failure scenario.** Any signed-in user calls `supabase.rpc('swap_slots', {_slot_a_id:<academy B slot X>, _slot_a_trainer_id:<arbitrary>, _slot_a_start/_end:<arbitrary>, _slot_b_id:<academy B slot Y>, …})` with slot ids belonging to a different tenant (UUIDs leak via public availability/booking/SEO pages). SECURITY DEFINER bypasses RLS, so both UPDATEs succeed: academy B's sessions get `trainer_id` reassigned and `start/end` overwritten (into the past, double-booked). Reassigning `trainer_id` also mis-routes future Mollie recipient resolution, which keys off `slot.trainer_id`/`academy_profile_id`.

**Why guards don't cover it.** RLS is bypassed by SECURITY DEFINER; no `BEFORE UPDATE` ownership trigger exists on `availability_slots`; no `REVOKE FROM PUBLIC` and no blanket `ALTER DEFAULT PRIVILEGES`, so the default PUBLIC grant stands. It is the **lone** SECURITY DEFINER mutator that neither gates on `auth.uid()`/ownership nor is restricted to `service_role` (every sibling definer writer carries an explicit `REVOKE ALL … FROM PUBLIC`). Client-side scoping is irrelevant since the attacker calls the RPC directly.

**Fix direction.** `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` and either (a) `GRANT` to `service_role` only and move the ownership check into the calling edge function, or (b) add an in-function guard resolving each slot's owner and requiring `auth.uid()` to manage that academy/trainer before the UPDATEs.

---

### P1-3 — `merge_guest_players` CASCADE-deletes session notes + training-location rows
**`supabase/migrations/20260612140000_m17_unique_active_bookings.sql:235`** · integrity/data-loss · CONFIRMED

**Code path.** `merge_guest_players` (live definition re-stated in `20260612140000`, **not** the earlier v3 file) repoints `bookings`/`invoices`/`intake_requests`/`slot_priority_claims`/`academy_player_metadata`, then `DELETE FROM guest_players WHERE id = p_source_guest_id`. Two CASCADE children are never repointed. Reachable via `src/components/players/MergePlayersDialog.tsx:154`.

**Failure scenario.** A trainer has `session_player_notes` about guest A and `academy_player_locations` for guest A. An admin merges A (source) into B (target). The RPC repoints the enumerated tables but **not** `session_player_notes.subject_guest_player_id` (ON DELETE CASCADE) nor `academy_player_locations.guest_player_id` (ON DELETE CASCADE) — both tables introduced 2026-06-15, *after* the merge fn was last written. The `DELETE` of A cascades and permanently destroys every session note and training-location row instead of moving them to B. The merge reports success; the data is unrecoverable.

**Why guards don't cover it.** SECURITY DEFINER bypasses RLS; the repoint list is a hardcoded enumeration that predates the two tables; the FK CASCADE fires in the same committed transaction; the manager/trainer auth gate only restricts *who* can merge, not whether the cascade destroys notes. No later migration redefines the function to add the repoints.

**Fix direction.** Before the `DELETE`, add `UPDATE session_player_notes SET subject_guest_player_id = p_target WHERE … = p_source` and `UPDATE academy_player_locations SET guest_player_id = p_target WHERE … = p_source` (handling the `apl_uniq_guest` partial-unique collision the same dedup-then-repoint way `slot_priority_claims` is handled). Audit every ON DELETE CASCADE child of `guest_players` and add a repoint for each; add a regression test asserting merge preserves all guest-keyed rows.

---

### P1-4 — `payment_pending` holds excluded from M-17 index → webhook wedges on paid booking
**`supabase/migrations/20260612140000_m17_unique_active_bookings.sql:44`** · concurrency/money · CONFIRMED

**Code path.** M-17 uniques `uniq_active_booking_per_slot_guest`/`_player` cover `status IN ('pending','confirmed','completed')` only; a guest hold is inserted as `status='payment_pending'` (invisible to the index); a staff-add creates a second `confirmed` guest row; `mollie-webhook` → `applyBookingPaymentWriteback` `UPDATE payment_pending→confirmed` hits 23505; there is no `ON CONFLICT`/23505 catch → HTTP 500 → infinite Mollie retry.

**Failure scenario.** Slot X (`max_participants >= 2`). Guest G books via the public widget → a `payment_pending` hold H for (X,G) is inserted and Mollie checkout starts. Before G pays, academy staff add the **same** guest G to X from the roster: the FE occupancy read (`CAPACITY_OCCUPYING_STATUSES` excludes `payment_pending`) doesn't show H, and the capacity trigger counts seats but has no per-(slot,guest) identity dedup, so a second `confirmed` row R is admitted. G pays → the webhook flips H `payment_pending→confirmed` → collides with R on the M-17 guest index (23505) → webhook 500s → Mollie retries forever. **Money captured, booking never confirmed, no invoice/confirmation email.**

**Why guards don't cover it.** The advisory lock in `book_guest_slot_for_payment` only dedups the same guest's holds at insert time and can't see a later staff insert. The capacity trigger enforces count, not identity uniqueness, so a duplicate guest passes on a slot with spare capacity. `service_role` bypasses the trigger but **not** the hard UNIQUE index, and there is no conflict handling anywhere in the webhook. M-17's status set was chosen before `payment_pending` holds existed. (Held at P1 rather than P0: requires a concurrent same-guest race, money is recoverable-not-lost, and the outer catch fires a Slack alert — not silent.)

**Fix direction.** Prefer (a) extend the M-17 partial unique indexes to also include `'payment_pending'` so a live hold blocks a duplicate active booking at insert time (staff-add fails fast). Alternatively (b) make `applyBookingPaymentWriteback` tolerate 23505 on `payment_pending→confirmed`: detect the pre-existing active booking, cancel the redundant hold, attach the payment/invoice to the survivor, and never return 500 for a duplicate.

---

### P1-5 — Authenticated single-slot charge omits `extra_costs` but the invoice bills them
**`supabase/functions/create-mollie-payment/index.ts:333`** · money/charge-vs-invoice · CONFIRMED

**Code path.** `BookLesson.tsx` sends `amount = getSlotPrice(slot)` (base only); `create-mollie-payment` recomputes `computeSingleSlotPaymentAmount` (no extras) and charges/stamps base as `payment_amount`; the webhook → `auto-create-invoice` builds the session line from `payment_amount` **then unconditionally appends every slot/cycle `extra_costs` line**; the invoice is minted `status='paid'` via `allPaid`.

**Failure scenario.** Academy slot `price_per_session=€20`, `extra_costs=[{Baanhuur, €5}]`. Logged-in player books online; Mollie captures **€20**. The webhook auto-creates an invoice with a €20 session line + a €5 "Baanhuur" line = **€25**, marked paid. €5 of extras is never collected, but the invoice (and any bookkeeping forward) reports €25 received; VAT is reported on €25. Recurs on every such booking.

**Why guards don't cover it.** The webhook amount guard only checks `sum(payment_amount) == Mollie paid` — it validates the *charge*, never the invoice total. `auto-create-invoice` appends extras with no comparison to what was charged, and the fresh-creation path marks `status='paid'` via `allPaid` regardless of total. No path reconciles `invoice.total` against the captured amount. The **guest** single-slot path deliberately adds `sumSlotExtraCosts` to the charge — proving the authenticated path's omission is the bug.

**Fix direction.** Make charge and invoice agree via one shared "did the charge include extras?" decision: either include `sumSlotExtraCosts` in `computeSingleSlotPaymentAmount` for the authenticated single-slot charge (mirroring the guest path), OR have `auto-create-invoice`/`invoiceSync` skip appending `extra_costs` when `payment_amount` already represents the fully-charged pay-first amount. (Fix jointly with P2-7, the opposite-direction bug.)

---

### P1-6 — `auto-create-invoice` TOCTOU overlap-dedup double-bills a booking
**`supabase/functions/auto-create-invoice/index.ts:531`** · money/concurrency · CONFIRMED

**Code path.** `.overlaps('booking_ids', bookingIds)` SELECT then INSERT with no advisory lock/serializable txn; the only DB backstop is `uniq_invoice_active_player_bookings`/`_guest_` keyed on `md5` of the **exact sorted set** (`20260503101100`); the 23505 recovery branch is gated on `code == 23505`, which never fires for unequal sets.

**Failure scenario.** For one player/guest on trainer T with cycle bookings A and B: request 1 (roster-add or a manual subset invoice) calls `auto-create-invoice` with `bookingIds=[A]`; request 2 (Mollie paid side-effect or `generate-cycle-commitment-invoices`) calls with `[A,B]` concurrently. Both `.overlaps()` reads return empty (neither committed), both compute distinct `md5` keys, both INSERTs succeed. Booking A is now billed on **two active invoices** → the player is charged for session A twice.

**Why guards don't cover it.** The `.overlaps()` guard is a non-transactional read-before-write with no lock; the partial unique index enforces exact-set uniqueness (`md5` of the full sorted array), so any two overlapping-but-unequal sets bypass both the read guard (race) and the index (different key). The 23505 recovery path is never entered for unequal sets. Independent service-role triggers can target the same recipient concurrently.

**Fix direction.** Serialize per-recipient (`trainer_id` + player/guest) with `pg_advisory_xact_lock` inside a SECURITY DEFINER RPC that does the overlap check + insert atomically, OR add a GiST exclusion constraint on `booking_ids` array overlap scoped to active status so overlapping sets conflict at the DB, not just identical ones.

---

### P1-7 — Cycle invoice re-sync silently truncates at 1000 bookings
**`src/lib/invoiceSync.ts:584`** · money/scale · CONFIRMED

**Code path.** `syncSplitCountForCycle` / `syncInvoicesAfterPriceChange` / `syncInvoicesAfterBookingRemoval` fetch bookings via unbounded `.in('slot_id', slotIds)` (PostgREST default 1000-row cap, no max-rows override), then feed the truncated ids into `.overlaps('booking_ids', …)` to locate invoices to rebuild.

**Failure scenario.** A legacy mega-cycle (~322 sessions × 4 players ≈ 1288 bookings). The manager edits the cycle price → the bookings fetch returns only the first 1000 rows, so only the invoices overlapping those 1000 are rebuilt. Invoices for the remaining ~288 bookings keep the **old** amount → those customers are billed the stale price after a deliberate change, with no error surfaced.

**Why guards don't cover it.** The GIN index only speeds `overlaps()`; it cannot restore bookings the earlier fetch dropped. No `.limit`/`.range`/pagination on the bookings fetch and no server-side max-rows override, so truncation is invisible (non-empty result, no error). `recalc_cycle_split_count` writes `split_count` correctly, but the client-side rebuild only touches invoices found via the truncated ids. (Blast radius is gated behind a mega-cycle scale the product now actively avoids by splitting cycles — one voter suggested P2 for that reason; kept P1 because it is a silent money-accuracy defect on the money path with no *structural* guard preventing a new large cycle.)

**Fix direction.** Page/batch the bookings fetch (the slotId-chunking pattern already used by `bulk-rebook-cycle`'s 200-id batches), or select booking ids via a keyset/range loop until exhausted; never rely on a single unbounded `.in()` whose result can exceed 1000 rows on the money path.

---

### P1-8 — Stripe subscription webhook reads removed top-level `invoice.subscription` (basil API) — **DISPUTED**
**`supabase/functions/stripe-subscription-webhook/index.ts:126`** · money/stripe · DISPUTED

**Code path.** The webhook pins `apiVersion '2025-08-27.basil'`; `invoice.paid` (line 126) and `invoice.payment_failed` (line 155) read `invoice.subscription` (removed at top-level in basil) then `if (!subscriptionId) break;`; the same field feeds the `eventSubscriptionId` dedup key (line 65).

**Failure scenario.** A trainer's monthly subscription renews. If Stripe delivers a basil-shaped `invoice.paid` (no top-level `.subscription`), `subscriptionId` is undefined and the handler `break`s without advancing `trainer_profiles.subscription_ends_at`. Once `ends_at` passes, DB-driven gating treats the paying tenant as expired until they open the subscription page (`check-stripe-subscription` re-syncs live). Symmetrically, a failed renewal never sets `past_due`, so a lapsed payer keeps full access.

**Why guards don't cover it / why DISPUTED.** `check-stripe-subscription` self-heals only on an authenticated visit; between visits every gate reads stale DB columns. There is no `deno check` gate (P2-9) so the removed-field access does not fail the build. **DISPUTED** because the payload shape is set by the API version pinned on the Stripe webhook **endpoint** (Dashboard), not by the SDK constructor `apiVersion` — not observable from source; a pre-basil endpoint would still carry the field and both handlers would work. One reviewer also noted `current_period_end` is likewise removed on basil (would throw `RangeError`, not silently no-op), complicating the exact mechanism.

**Fix direction.** Resolve the subscription id from `invoice.parent.subscription_details.subscription` (fallback to line-item subscription and to `invoice.subscription` for older events) in both handlers and in `eventSubscriptionId`; add basil fallbacks for `current_period_end`; add a `deno check` gate so removed-field access surfaces at build time. **Confirm the endpoint's pinned API version in the Stripe Dashboard before prioritizing.**

---

### P1-9 — Academy slot silently routes money to the trainer's PERSONAL Mollie
**`supabase/functions/_shared/guest-payment.ts:121`** · money/mis-routing · CONFIRMED

**Code path.** `resolveSlotRecipient`: the academy branch is taken only when `academyMollie.access_token && charges_enabled` (line 110); otherwise it falls through to `if (!accessToken)` (line 121) and charges the trainer's **personal** `trainer_mollie_accounts`; mirrored on the confirm side in `mollie-webhook` `resolveAccessToken`.

**Failure scenario.** An academy publishes a public slot for member trainer T. The academy's Mollie is temporarily not charge-ready (mid-onboarding, a Mollie KYB hold flips `charges_enabled=false`, or the row is absent) and T has their own `onboarding_complete` personal Mollie. A guest books and pays: the full price (plus extras) lands in **T's personal account**, and the platform fee is computed on the trainer tier instead of the academy tier. The webhook resolves the recipient with the identical predicate, confirms the seat, and never flags the misroute. The academy is never paid for its own slot.

**Why guards don't cover it.** The guest-function visibility guards check only `is_public` and tier windows — never academy Mollie readiness. The webhook uses the **same** trainer-fallback predicate, so charge-org == confirm-org and the amount guard passes. No DB constraint/RLS forbids a trainer who belongs to an academy from also holding a personal connected Mollie. This contradicts the functions' own documented contract ("an academy slot routes to the ACADEMY's Mollie only").

**Fix direction.** For a slot carrying `academy_profile_id`, `resolveSlotRecipient` (and callers) must **refuse** rather than fall back: if the resolved academy has no charge-ready Mollie, return no recipient (`no_mollie_account`) so the booking is blocked instead of paid to the wrong account. Only trainer-owned slots (`academy_profile_id` null) may use the trainer-Mollie branch.

---

### P2-1 — Anon "view open cycles" RLS leaks `notify_admin_emails` + full settings
**`supabase/migrations/20260123104639_*.sql:60`** · rls/tenancy · CONFIRMED

**Code path.** `cycles` SELECT policy `"Anyone can view open cycles"` `USING (status='open')` with **no TO clause** (anon-reachable); the `settings` JSONB is a plain selectable column; public read path `src/lib/cycles.ts:220` `select('*')` via the unauthenticated route `register/:cycleId`.

**Failure scenario.** An unauthenticated attacker calls `GET /rest/v1/cycles?status=eq.open&select=settings` with the anon key (or opens `/register/<cycleId>`) and receives `settings.notify_admin_emails` — a private list of academy/trainer staff notification emails — plus `terms` and other internal settings, for every open cycle across all tenants. Enumerating open cycles harvests every academy's admin emails (spam/phishing target, GDPR exposure).

**Why guards don't cover it.** No column-level restriction and no `_public`/`_safe` view interposed — `getCycle` reads the base table directly. The anon role satisfies `status='open'`; no later migration (verified across all 11 `cycles`-referencing migrations) adds a TO clause or drops the policy.

**Fix direction.** Serve the public registration form through a postgres-owned `_public` view whitelisting only form-safe columns (excluding `settings`/`notify_admin_emails`/internal `terms` keys), or strip sensitive settings keys into a manager-only column; restrict the anon policy to `TO authenticated` and add an explicit public view for the form.

---

### P2-2 — Academy managers can read a shared trainer's entire `guest_players` roster
**`supabase/migrations/20260224171306_*.sql:37`** · tenancy/PII · CONFIRMED

**Code path.** The `guest_players` SELECT policy keys off `trainer_id` via an active `academy_trainers` link (`get_user_academy_ids`); no per-academy scoping on the guest row; duplicated/reinforced by `20260325192818` and `20260210221411`.

**Failure scenario.** Trainer T has 200 private guest clients (`academy_profile_id` NULL, `trainer_id=T`) created solo. T later accepts an active invite to Academy B. Academy B's manager can immediately `select * from guest_players where trainer_id = T` and read all 200 clients' names, emails and phone numbers — none of whom ever engaged Academy B — plus guests T created in any other academy's context.

**Why guards don't cover it.** The `trainer_id` branch matches solely on the active trainer↔academy link, so the guest's originating academy/context is never checked; the `academy_profile_id` OR-branch does not narrow it. No column-level `REVOKE` protects the PII columns. `get_user_academy_ids` does not restrict to owner role. RLS OR-combines the duplicate policies, reinforcing the exposure.

**Fix direction.** Scope academy-manager guest visibility to guests actually associated with that academy (require `guest_players.academy_profile_id` match, or an existing booking of the guest on one of the academy's slots) rather than `trainer_id` membership alone. **Confirm with product whether shared-trainer guest sharing is intended before narrowing.**

---

### P2-3 — `rebook_group_manage` appends bookings onto an arbitrary client-supplied invoice
**`supabase/migrations/20260626110000_rebook_group_manage.sql:262`** · tenancy · CONFIRMED

**Code path.** `rebook_group_manage` (SECURITY DEFINER, GRANT anon/authenticated) final step: `UPDATE invoices SET booking_ids = (… || v_new_ids) WHERE id = _invoice_id AND status='paid'`; `_invoice_id` is a client-supplied param (`src/lib/priorityClaims.ts:744`) with no `rebook_group_id`/ownership scope.

**Failure scenario.** A legitimately-paid captain (passing the captain claim/payment gate) calls the RPC directly with `_invoice_id` = the UUID of a **different** paid invoice (seen on another `/pay/:token` page or enumerated). The RPC appends their group's booking ids to that unrelated, already-paid invoice's `booking_ids`, corrupting a stranger's invoice record and mis-attributing seats. `reconcile_payments` later reads these foreign ids as part of the victim invoice's coverage set.

**Why guards don't cover it.** The gate only checks the *captain's own* claim/payment state; it never scopes `_invoice_id`. The `UPDATE` constrains only `id` and `status='paid'`. The unique partial index on `invoices(rebook_group_id)` prevents a second group invoice but not writing to an invoice the caller doesn't own. SECURITY DEFINER means no RLS backstop. Direct money loss is bounded (foreign bookings already paid), but it is an unauthorized cross-record/cross-tenant write.

**Fix direction.** Add a scope check to the step-4 UPDATE: require the invoice to be the group's own, e.g. `WHERE id=_invoice_id AND status='paid' AND rebook_group_id = v_group` (the `create-group-rebook-invoice` path tags it), or verify the invoice's recipient matches the captain identity before linking.

---

### P2-4 — Transient probe failure on re-pay mints a second open payable checkout
**`supabase/functions/create-mollie-payment/index.ts:560`** · money/double-charge · CONFIRMED

**Code path.** The existing-bookings re-pay path sets `recreatedAfterPaymentId` before probing the prior payment; the stale-payment DELETE lives only inside the `probe.ok && prior.status==='open'` branch; a probe throw (catch, line 560) or non-ok falls through to mint a fresh salted-key payment without cancelling P1.

**Failure scenario.** A player clicks Pay (checkout P1, open), clicks again; the probe of P1 hits a transient Mollie error. The function mints P2 (fresh, **salted key** so Mollie does NOT dedupe), stores P2 as the booking's `mollie_payment_id`, but never cancels P1. The player now has two payable checkout URLs (the earlier tab still shows P1). If they complete both, they are **charged twice**; the second capture is real money with no second seat.

**Why guards don't cover it.** The already-paid guard only fires if a prior payment is confirmed paid at request time, not for two concurrently-open checkouts. The salted idempotency key means Mollie treats P2 as genuinely new. The webhook amount-sum guard accepts each payment independently (both equal the same expected sum). After P2 overwrites `mollie_payment_id`, P1's later webhook can't resolve a token, so P1's capture is never even recorded.

**Fix direction.** On a probe failure, do not fall through to minting fresh — reuse the prior payment's checkout, or explicitly cancel it first and only mint when the prior payment is confirmed cancelled/expired/failed.

---

### P2-5 — Refund and chargeback webhooks are silently ignored
**`supabase/functions/mollie-webhook/index.ts:616`** · money/reversals · CONFIRMED

**Code path.** The status switch (616–635) has no case for `'charged_back'`/`'refunded'` → default → `paymentStatus`/`bookingStatus='pending'`; `applyBookingPaymentWriteback` filters `.neq('payment_status','paid')` so an already-paid row is untouched and no Slack alert fires; grep confirms no refund/chargeback handler anywhere.

**Failure scenario.** A player pays €120 for a cyclus (bookings flip to paid/confirmed), then initiates a bank chargeback. Mollie sends `status='charged_back'`; the webhook maps to default→pending, the `.neq(paid)` guard blocks any change, and it returns 200 with **no alert**. The money is gone but the 4 sessions remain confirmed/paid forever, the seat stays occupied, and no one is notified. A full refund (status stays `'paid'`, `amountRefunded` populated) is logged as `duplicate_webhook_ignored` — likewise unreconciled.

**Why guards don't cover it.** The no-downgrade guard (`.neq payment_status paid`) protects data but also silences the reversal — it is never recorded or surfaced. The invoice branch acts only on `status==='paid'`. There is no `amount_refunded`/`charged_back` processing anywhere in `supabase/functions`.

**Fix direction.** Add explicit handling for `status==='charged_back'` and for `amountRefunded`/`amountChargedBack` non-zero: do not resurrect state, but write a `payment_audit_log` row and fire a Slack alert for manual reconciliation (mirroring the existing cancelled-invoice/cancelled-booking manual-refund alerts), and consider flagging the booking/invoice for review.

---

### P2-6 — `recalculate-invoices` overwrites a just-paid invoice (no status guard)
**`supabase/functions/recalculate-invoices/index.ts:276`** · money/invoice-integrity · CONFIRMED

**Code path.** `SELECT` invoices `status in (draft,sent,pending)` at read time; the loop `UPDATE .update(payload).eq('id', inv.id)` has **no status re-check** and no `updated_at` optimistic guard; the payload overwrites `subtotal/vat/total/line_items` and nulls `pdf_url`; the invoice-lock trigger is exempt for service role (`auth.uid() IS NULL` early-return).

**Failure scenario.** An admin triggers `recalculate-invoices` over a batch including invoice X in status `'sent'`. Mid-loop, the Mollie webhook flips X to `'paid'` with the correct total. The recalc loop reaches X, computes `newTotal` from stale/edited line data, and blindly UPDATEs X — corrupting the paid invoice's stored total/subtotal/VAT and wiping `pdf_url`, so the customer's paid invoice now shows a different amount than was charged.

**Why guards don't cover it.** The status filter is applied only at the initial SELECT; the UPDATE carries no `.neq('status','paid')` and no `updated_at` guard, so any transition between read and write is clobbered. The `protect_invoice_financial_columns` trigger short-circuits when `auth.uid() IS NULL`, and recalc runs as service role, so the paid-invoice lock never fires. The codebase already knows this write class needs guarding (`mollie-webhook` uses `.neq('status','paid')`; `invoiceSync` uses `updated_at` optimistic concurrency) — recalc uses neither.

**Fix direction.** Add a status guard to the UPDATE (`.in('status',['draft','sent','pending'])` or an `updated_at` optimistic `.eq('updated_at', inv.updated_at)`) and treat a zero-row result as skipped/conflict rather than success.

---

### P2-7 — Guest single-slot invoice double-counts `extra_costs`
**`supabase/functions/create-guest-slot-payment/index.ts:161`** · money/invoice-integrity · CONFIRMED

**Code path.** The guest single-slot flow charges `computeSingleSlotPaymentAmount + sumSlotExtraCosts` and stamps `base+extras` as `payment_amount`; `auto-create-invoice` builds the session line from `payment_amount` (already `base+extras`) **and separately re-appends** the same `extra_costs` as extra lines (`index.ts:368-393`); mirrored in `src/lib/invoiceSync.ts`.

**Failure scenario.** Public slot `price_per_session=€20`, `extra_costs=[{Ballen, €3}]`. Guest is charged **€23** (Mollie captures €23 — correct). `auto-create-invoice` emits a €23 session line + a €3 "Ballen" line = **€26**, marked paid. The invoice overstates by €3; VAT/revenue reporting is wrong, and any re-issue would bill €26 for a €23 booking.

**Why guards don't cover it.** The webhook validates `sum(payment_amount) == paid` (=€23), which passes; it never checks invoice total. The extras branch runs whenever slot/cycle `extra_costs` exist and does not detect that `payment_amount` already folded extras in. Dedup guards only prevent a second invoice *row*, not the inflated total on the one invoice.

**Fix direction.** Single source of truth for extras: when `payment_amount` is a fully-charged pay-first amount that already includes extras, `auto-create-invoice`/`invoiceSync` must NOT re-append `extra_costs`. (Same charge/invoice-agreement root as P1-5, opposite direction — fix both under one shared decision.)

---

### P2-8 — `split-invoice` can double-halve a share-priced invoice — **PLAUSIBLE**
**`supabase/functions/split-invoice/index.ts:365`** · money/invoice-split · PLAUSIBLE

**Code path.** The `alreadySplit` guard trips only on `split_count>1` OR a `(1/N)` description marker; `auto-create-invoice` writes neither when bookings carry per-recipient `payment_amount` shares; `split-invoice` then divides the already-share total by N again; `hasPaymentAmount` is consulted only for *other* players' invoices, never to skip re-dividing the original.

**Failure scenario.** A share-priced but NON-paid invoice with no split markers (reachable via `backfill-invoices` `asDraft` on unpaid mid-Mollie bookings) is manually split by a trainer with other players present: `alreadySplit` is false, so the already-share total (e.g. €19) is divided by N again (→ ~€4.75 for N=4) and N−1 further invoices are created for the same shared bookings — **under-billing** the guest.

**Why guards don't cover it / why PLAUSIBLE.** The `alreadySplit` check keys off `split_count` and the `(1/N)` marker, both intentionally absent on `payment_amount`-priced invoices; `hasPaymentAmount` is never used to skip re-dividing the original. PLAUSIBLE (not P1): the confidently-stated guest-pays-then-split path is blocked twice (post-payment invoices are `status='paid'`; split rejects paid invoices and the UI hides the split button), so the reachable path is the narrow `backfill`-then-manual-split admin/timing corner.

**Fix direction.** Before dividing the original invoice, detect `payment_amount`-priced bookings (reuse `bookingsUseSplitShareAmounts` / check the invoice's bookings for explicit `payment_amount`) and refuse/no-op the split when the invoice already reflects per-recipient shares.

---

### P2-9 — No type/`deno check` gate for the 96 edge functions
**`.github/workflows/test.yml:119`** · ci/reliability · CONFIRMED

**Code path.** The only edge-fn job is `deno test --no-check … supabase/functions/_shared/` (`--no-check` disables typing, `_shared` only); `tsconfig.app.json` `include:['src']` excludes `supabase/functions`; ESLint has no `parserOptions.project` (not type-aware, `no-undef` off); no `deno check` anywhere.

**Failure scenario.** A developer edits `mollie-webhook/index.ts` and references a helper that isn't imported or misspells an aliased import (e.g. `auditLog`). Vitest, `deno test` (`--no-check`, `_shared` only), ESLint (not type-aware), `tsc` (function out of scope) and `vite build` are all green; the PR merges. On the next Mollie webhook the function throws `ReferenceError` **before** flipping the invoice/booking to paid → customer paid but booking never marks paid, and side-effects (confirmation email, roster) never fire.

**Why guards don't cover it.** The extracted `_shared/*` modules are unit-tested, but the orchestration wiring in each function's `index.ts` is neither type-checked nor deno-checked by any job; `--no-check` disables Deno's type phase and `tsconfig.app.json`'s `include:['src']` excludes the functions. (Held at P2 because it is a missing-gate/latent-risk with no present-tense bug in the tree — it requires a future edit — though the unguarded surface is the money-critical webhook.)

**Fix direction.** Add a CI job running `deno check` (not `--no-check`) across `supabase/functions/**/index.ts` with the project's import map, ratcheted vs a baseline like the tsc gate. At minimum type-check the money-path functions (`mollie-webhook`, `mollie-callback`, `create-*-payment`).

---

### P2-10 — Fresh single-slot booking orphans a capacity-occupying row on Mollie failure
**`supabase/functions/create-mollie-payment/index.ts:619`** · reliability/capacity · CONFIRMED

**Code path.** The fresh single-slot path: `book_slot_for_payment` INSERTs `status='pending'`, `payment_status='pending'`, no `hold_expires_at`, no `mollie_payment_id`; the missing-profile early-return (684) and the Mollie-error throw/catch (750/795) never soft-cancel the just-inserted booking; no sweep matches `status='pending'` with NULL `hold_expires_at`.

**Failure scenario.** A player books a single slot online; the connected account has no Mollie profile (400) or Mollie returns a 4xx. The edge function inserts the pending booking, then errors out. The booking persists forever: no `mollie_payment_id` (so no expired/canceled webhook ever cancels it) and no `hold_expires_at` (so the payment_pending sweeps never touch it). On a whole-slot session (effective capacity 1), that one orphan row makes `book_slot_for_payment` raise `slot_full` for every future booker until staff manually cancel it. Repeated failures starve capacity across the schedule.

**Why guards don't cover it.** The abandon-after-checkout case IS covered (the booking gets a `mollie_payment_id`, so Mollie's expired webhook cancels it). The uncovered case is failure **before** a payment id is ever assigned: no webhook fires, and both sweeps require `status='payment_pending'`. The client cannot roll back because the booking is created internally and only an error is returned. The multi-slot cyclus path's A3 rollback (`initiateCyclePayment`) does not apply here.

**Fix direction.** Track the booking id created by `book_slot_for_payment` and soft-cancel it in the missing-profile early-return and in the catch/Mollie-error branches (mirror `initiateCyclePayment`'s A3 rollback), OR insert the fresh single-slot booking as a TTL hold (`status='payment_pending'` + `hold_expires_at`) so the existing sweep reclaims it.

---

### P2-11 — `send-schedule-notifications` double-sends on concurrent invocation
**`supabase/functions/send-schedule-notifications/index.ts:234`** · reliability/email · CONFIRMED

**Code path.** Reads all `intake_requests status='booked'` (105–109), emails each in a loop (200), flips successful ones to `'notified'` only **after** the whole loop (234–242); no per-row atomic claim before send and no cron/advisory lock, unlike `process-onboarding-emails`/`send-priority-claim-invitation`.

**Failure scenario.** Two overlapping invocations (two tabs/devices at the `'booked'` state, or a slow-then-retried send) both SELECT the same set of `status='booked'` intake requests before either reaches the bulk `'notified'` UPDATE, so every booked player receives the schedule-notification email twice.

**Why guards don't cover it.** The booked→notified transition happens once at the end in bulk and does not gate the send; both snapshots see `'booked'`. `send-email` has no dedup for type `schedule_notification`. The per-component UI disable guards a single-tab double-click but does not coordinate across tabs/devices.

**Fix direction.** Claim each intake row atomically before sending (`UPDATE … SET status='notified' WHERE id=? AND status='booked' RETURNING`, send only when a row was claimed; release/retry on failure), or wrap the run in `try_lock_cron_job` single-flight like `process-onboarding-emails`.

---

### P2-12 — Paid strict-hold confirmed without finalizing its priority claim
**`supabase/functions/verify-mollie-payment/index.ts:350`** · reliability/priority-claims · CONFIRMED

**Code path.** `verify-mollie-payment` flips strict-hold bookings to paid/confirmed and runs `runBookingPaidSideEffects`, which does **not** mark `slot_priority_claims` `'claimed'` (only `mollie-webhook` does, 763–784); on webhook-loss the claim stays `'pending'` and is later cron-expired; `computeReleasedSlotIds` treats expired-not-claimed as freed.

**Failure scenario.** A strict rebook hold is paid; the user lands on the success page and `verify-mollie-payment` confirms the booking, but the Mollie webhook is dropped/never delivered. `slot_priority_claims` stays `'pending'`, is later flipped to `'expired'` by `expire_lapsed_priority_claims`, and `computeReleasedSlotIds` (which inspects claims only, never whether a PAID booking occupies the seat) treats the slot as freed to the public tier — a potential seat leak / overbook of an already-paid seat.

**Why guards don't cover it.** The webhook normally backstops the claim update, so this manifests only on webhook-loss. The claim finalization lives only in the webhook, not in the shared paid-side-effects that `verify` calls. The expiry cron cancels the claim record but the release logic keys off claim state, not the paid booking. (One reviewer noted the finding *understates* impact — the freed-seat/overbook leg is plausible; bounded by webhook-loss frequency and by the paid player being the last pending claim, hence P2.)

**Fix direction.** Factor priority-claim finalization out of the webhook and run it from `runBookingPaidSideEffects` (or `verify` directly) so whichever path confirms the strict-hold booking also settles its claim, independent of webhook delivery.

---

### P2-13 — `EditInvoiceDialog` detects price changes by array index
**`src/components/invoices/EditInvoiceDialog.tsx:206`** · frontend/money-display · CONFIRMED

**Code path.** `originalPrices` maps `unit_price` by **array index**; `hasPriceChanges` compares `lineItems[i]` vs `originalPrices[i]`; `removeLineItem` filters an item out, shifting subsequent indices; the sync checkbox render + trigger gate on the buggy `hasPriceChanges`.

**Failure scenario.** Invoice `[A €50, B €30, C €30]`. User deletes A. The array becomes `[B €30, C €30]` at indices 0,1; `originalPrices[0]=50`. `hasPriceChanges` compares B's 30 vs 50 → true even though no price was edited. The "Sync to bookings" checkbox (gated on `hasPriceChanges && hasBookings`) appears spuriously; if ticked, `sync-invoice-to-bookings` force-writes every booking's `payment_amount` based on an unchanged invoice.

**Why guards don't cover it.** Displayed totals recompute correctly from live `lineItems`, so totals are right — but the sync trigger keys off the buggy index-based flag. The `?? li.unit_price` fallback only defends appended tail indices, not shifted middle ones. No DB/RLS blocks the sync (the edge fn only checks manage permission, which the editor has). Held at P2 because the harmful sync is opt-in (user must tick the box).

**Fix direction.** Detect price changes by stable identity (compare original line items by description or a synthetic id, or by a normalized signature) rather than positional array index.

---

### P2-14 — Cycle price/roster mutations never invalidate invoice/player caches
**`src/components/cycles/CycleDetailView.tsx:516`** · frontend/cache · CONFIRMED

**Code path.** `handleSavePrice`/`handleAddPlayer`/`handleSwapPlayer`/etc. mutate invoices + player billing but only invalidate `['cycle-detail', cycleId]` plus an optional `onMutated?.()`; `AcademyCycleDetailView`/`TrainerCycleDetailView` pass **no** `onMutated`; global `staleTime=60_000` (App.tsx) defeats remount-refetch.

**Failure scenario.** Academy edits a cycle price from €20 to €30/session on `/app/academy/cycles/:id` (invoices resync to €30 in the DB), then switches to `/app/academy/invoices` (already cached, 60s stale window) → invoice rows still show the old €20 totals until a hard refresh or the 60s window elapses.

**Why guards don't cover it.** The only cross-surface hook is `onMutated`, which both academy and trainer wrappers omit; the global 60s `staleTime` + 10min `gcTime` means an already-cached invoices/player list serves stale data with no refetch. The DB is correct — this is a stale cached *view*, self-heals after 60s, hence P2.

**Fix direction.** After roster/price/end-date mutations, also invalidate the invoice list keys (`['academy-invoices']`/`['trainer-invoices']`) and call `invalidateAllPlayerData` for the owning `academyProfileId`/`trainerId`, or wire `onMutated` from the wrappers to do so.

---

### P2-15 — Account-deletion deletes guests before invoices under a RESTRICT FK
**`supabase/functions/_shared/delete-user-data.ts:127`** · reliability/integrity · CONFIRMED

**Code path.** Trainer branch order: `availability_slots.delete` (126) → `guest_players.delete` (127) → `invoices.delete` (128); `invoices.guest_player_id` is RESTRICT/NO ACTION, so the guest delete is FK-rejected and the error is never destructured/checked (swallowed); the flow self-heals only via the later `trainer_profiles` cascade; `bulk-cleanup-users:144-145` is identical.

**Failure scenario.** An admin deletes a trainer with any guest booking that generated an invoice (the common case). `guest_players.delete()` at 127 fails with an FK violation (invoices still reference the guests); the error is swallowed, so the intended explicit deletion never happens. Execution continues, invoices are deleted (128), and `trainer_profiles` is deleted (157), whose `guest_players.trainer_id` ON DELETE CASCADE then cleans up the guests. The flow works only by accident of the later cascade and reports success.

**Why guards don't cover it.** No error handling on the delete calls, so the FK failure cannot surface or abort. It self-heals ONLY because `trainer_profiles→guest_players` is CASCADE and invoices were already deleted by 128; if 128 were reordered/failed, or a non-cascading FK on `guest_players` were added (`intake_requests.guest_player_id` is also NO ACTION and is only deleted by `cycle_id`, not by the trainer's guest ids), the `trainer_profiles` delete at 157 would itself be RESTRICT-blocked and stall the deletion mid-way, leaving a partially-deleted user.

**Fix direction.** Reorder to delete invoices before `guest_players`, and destructure `{ error }` on each sequential delete and abort/log on failure so a real FK violation is never swallowed. Apply the same reorder + error-check to `bulk-cleanup-users:144-145`.

---

### P2-16 — `get-admin-stats` loads entire tables → wrong GMV past 1000 rows
**`supabase/functions/get-admin-stats/index.ts:78`** · scale/reliability · CONFIRMED

**Code path.** Six uncapped selects (`bookings`, `trainer_profiles`, `profiles`, `trainer_mollie_accounts`, `club_profiles`, `guest_players`) with no `.limit`/`.range`/`count`; all aggregation (GMV 138–139, fees 171, trends 202–221, guest conversion 224–230) done in JS over PostgREST-capped (1000-row) arrays; live via `src/lib/admin.ts:173`.

**Failure scenario.** Once the platform passes 1000 total bookings, `bookingsResult.data` returns only 1000 rows. `totalGMV`, `paidBookings` count, `estimatedTotalFees` and monthly trends are computed over a truncated slice → the admin financial dashboard reports **materially understated GMV/fees** with no error. At 100k+ bookings, removing the cap would instead load the whole table into the function → memory pressure / timeout.

**Why guards don't cover it.** No SQL aggregation and no COUNT/SUM RPC; all math is client-side over the capped arrays. The admin-only auth gate doesn't affect correctness. No `data.length===1000` truncation check.

**Fix direction.** Move aggregation into SQL (`SUM`/`COUNT` with `date_trunc` for trends) via a SECURITY DEFINER RPC, or at minimum use `head:true` count queries and windowed date-ranged sums instead of pulling whole tables into the function.

---

### P3 findings (condensed)

- **P3-1 — `trainer_profiles_safe` leaks draft trainers to anon** · `supabase/migrations/20260612210000_p02_*.sql:8`. The view is re-created without `security_invoker` and without an `is_public` filter, re-GRANTed to anon while base-table anon SELECT policies were dropped — so an anon caller reads unpublished (`is_public=false`) trainers' name/slug/description/socials/ratings/rate. Non-PII, so unpublished-content disclosure, not a breach. *(The sibling `academy_profiles_safe` half of the original finding was refuted — its anon GRANT was destroyed by later DROP+CREATE cycles.)* **Fix:** add `WHERE is_public=true` to the view or drop the anon GRANT and route anon discovery through the `*_public` views.
- **P3-2 — New `registrations` table repeats the anon settings leak** · `supabase/migrations/20260628100000_registrations_table.sql:42`. Same shape as P2-1: anon `USING(status='open')` with no TO clause, and the `_registration_form_settings` whitelist carries `notify_admin_emails`. **Inert until Phase-2 backfill.** **Fix:** exclude `notify_admin_emails`/`notify_admin_on_submission` from anon-visible settings, or serve via a form-safe public view.
- **P3-3 — `get_player_locations` trusts caller-supplied `guest_player_id`** · `supabase/migrations/20260615110120_get_player_locations.sql:14`. SECURITY DEFINER authorizes the caller only as `is_academy_manager(p_academy_profile_id)`, not the player argument, so a manager passing a foreign guest's UUID can confirm that guest trains at venues overlapping the caller's clubs (per-venue boolean presence, no PII). **Fix:** assert the target player is associated with `p_academy_profile_id` (or scope the subqueries to the academy's slots).
- **P3-4 — Google Calendar callback open-redirect** · `supabase/functions/google-calendar-callback/index.ts:19`. Unsigned `state.redirectUrl` flows into `Response.redirect` on every exit path with no scheme/host allowlist → phishing redirect. Shares the unsigned-state root with P1-1. **Fix:** allowlist `redirectUrl` to app-relative paths + the signed-state fix.
- **P3-5 — Deduped-invoice paid-match tolerance has no absolute cap** · `supabase/functions/auto-create-invoice/index.ts:504`. Tolerance `= Math.max(0.01, invoiceBookingCount * 0.01)` scales linearly with booking count; on a 40-session cycle a €0.40 drift passes and auto-marks paid. Capped at cents. **Fix:** cap the tolerance (`min(bookingCount*0.01, 0.05)`) or verify against the recomputed line-item total.
- **P3-6 — Public-form rate limiter keys on spoofable first XFF hop** · `supabase/functions/send-email/index.ts:1218`. `partner_inquiry`/`location_request` derive the identifier from `x-forwarded-for.split(',')[0]` (attacker-controlled), so a fresh XFF per request bypasses the 3–5/hr cap → inbox spam to `info@padeltrainer.ai`. **Fix:** key on the last (proxy-appended) hop or `cf-connecting-ip`, matching the hardened guest-payment endpoints.
- **P3-7 — Rate limiters use non-atomic read-modify-write (TOCTOU)** · `supabase/functions/_shared/guest-payment.ts:154`. `SELECT count → compare → UPDATE count+1` with no row lock; ~20 parallel requests under one key all read the pre-increment count and pass a 5/hr cap. Exposure is extra Mollie load / hold churn / emails, not money loss. **Fix:** `INSERT … ON CONFLICT DO UPDATE SET request_count = request_count + 1 RETURNING` (as `create_rebook_group_guest` already does).
- **P3-8 — `forward-invoice` partial send re-emails successful recipients** · `supabase/functions/forward-invoice/index.ts:327`. On partial failure (`sent>0 && failed>0`), `forwarded_at` is reset to null, so a later resend re-sends to recipients that already succeeded → duplicate PDF to a bookkeeping mailbox. **Fix:** track per-recipient delivery and retry only failures.
- **P3-9 — `notify-followers` fetches all followers unbounded (PLAUSIBLE)** · `supabase/functions/notify-followers/index.ts:97`. A trainer with >1000 opted-in followers silently drops the overflow (only the send loop is chunked). PLAUSIBLE — depends on the live PostgREST max-rows default (assumed 1000). **Fix:** page the `trainer_followers` query.
- **P3-10 — Hardcoded foreign-project Supabase anon JWT in source** · `supabase/functions/import-pipeline-data/index.ts:12`. `SOURCE_API_KEY` is a compile-time literal (anon role, ~10-yr validity) for an external project — non-rotatable without a code change, unlike the sibling secrets which use `Deno.env.get`. Anon role, source-side RLS applies, so no breach in this repo. **Fix:** move to `Deno.env.get`; rotate the source key if it grants more than intended.
- **P3-11 — English users see Dutch text for the strict-Mollie rebook toggle** · `src/components/cycles/RebookPaymentModeField.tsx:106`. `t('rebookShared.strictMollie', '<dutch default>')` — the key is missing from `en/cycles.json` and the inline default is Dutch, so EN falls back to Dutch. **Fix:** add the EN key.

---

## 4. Prioritized remediation plan

Grouped into PR-sized slices, ordered by what to fix first and why. Each slice bundles findings that share a root cause or a code surface.

### Slice A — Kill the edge-auth service-role bypass and lock its blast-radius sink `[P0-1, P0-2]`  ⟵ **do first, before anything else**
The single most dangerous defect: an unauthenticated attacker gets full RLS-bypassing service-role on **every** helper-gated function, and `backup-database` turns that into a whole-DB exfil. Fix the root (remove the unsigned-JWT fallback; require a constant-time env-key match or verified signature; fail closed), then harden `backup-database` with its own verified-admin/env-key check as defense-in-depth. Everything else is lower blast-radius.

### Slice B — Sign and scope the Google Calendar OAuth flow `[P1-1, P3-4]`
Account-linking CSRF + token injection binds a victim's calendar sync to the attacker's Google tokens (ongoing PII exfil), and the same unsigned state is an open redirect. One PR fixes the shared root: HMAC-sign + expire the `state` with a server-side nonce bound to the initiating session, and allowlist `redirectUrl` to app-relative paths. Self-contained, no schema change.

### Slice C — Lock down unauthorized/cross-tenant SECURITY DEFINER writes `[P1-2, P2-3]`
`swap_slots` is the lone unguarded PUBLIC-EXECUTE definer mutator (any user can scramble any tenant's schedule and mis-route payments); `rebook_group_manage` links bookings onto an arbitrary invoice with no ownership scope. Both are migration-only guard additions (`REVOKE` + in-function ownership check for `swap_slots`; add `rebook_group_id`/recipient scope to the step-4 UPDATE).

### Slice D — Prevent permanent data loss on guest merge and account deletion `[P1-3, P2-15]`
`merge_guest_players` CASCADE-destroys session notes and training-location rows (irreversible); `delete-user-data`'s inverted RESTRICT-FK ordering swallows a real error and can stall account deletion mid-way. Data-integrity correctness: repoint every CASCADE child before the merge DELETE (+ regression test auditing all `guest_players` children); reorder invoices-before-guests and destructure/abort on every sequential delete error (also `bulk-cleanup-users`).

### Slice E — Close the `payment_pending` capacity/index gaps and orphaned-hold leaks `[P1-4, P2-10, P2-12]`
Same lifecycle theme (hold/booking across index, capacity, sweep, claim-finalization). The M-17 index gap wedges the webhook forever on a paid booking; the `create-mollie-payment` fresh-path failure orphans a capacity-occupying row; `verify-mollie-payment` leaves a paid strict-hold claim pending so the seat can be released. Extend M-17 to cover `payment_pending` (+ add 23505 tolerance), soft-cancel the fresh-path booking on Mollie failure (or insert as a TTL hold), and move priority-claim finalization into the shared paid-side-effects.

### Slice F — Make the Mollie charge and the auto-invoice agree on extras `[P1-5, P2-7, P2-8]`
Two opposite-direction money bugs share one root: the charge side and `auto-create-invoice`'s extras-append disagree. Authenticated single-slot under-charges extras but the invoice bills them (revenue lost, wrong VAT); guest single-slot charges extras once but the invoice double-counts them (over-billed, wrong VAT). Introduce a single "did the charge already include extras?" flag both the charge and the invoice honor, and reconcile `invoice.total` against the captured amount. Fold in the P2-8 split guard.

### Slice G — Fix invoice concurrency and mid-flight overwrite races `[P1-6, P2-4, P2-6, P3-5]`
`auto-create-invoice`'s TOCTOU overlap-dedup double-bills a booking; `recalculate-invoices` clobbers a just-paid invoice with no status guard; `create-mollie-payment`'s re-pay probe failure leaves two payable checkouts. All read-then-write / missing-guard races that can double-charge or corrupt paid invoices. Add per-recipient advisory locking or a GiST overlap exclusion, a `.neq('status','paid')`/`updated_at` guard on recalc, and cancel-before-mint on the re-pay path. Tighten the deduped-invoice tolerance in the same file.

### Slice H — Record payment reversals and prevent double-sent notifications `[P2-5, P2-11, P3-8]`
Refund/chargeback webhooks are silently ignored (money gone, seat stays confirmed, no alert); `send-schedule-notifications` double-sends on concurrent runs. "Reconcile/claim before acting" reliability gaps on customer-facing money/email paths. Add a `charged_back`/`amountRefunded` handler that writes an audit row + Slack alert; add an atomic per-row claim (or single-flight lock) before emailing. `forward-invoice`'s partial-send re-email is the same claim-granularity theme.

### Slice I — Add an edge-function `deno check` CI gate + fix Stripe basil field reads `[P2-9, P1-8]`
Zero type-check for the 96 edge functions means a mis-imported name in the money-critical webhook ships as a runtime error — the Stripe webhook's removed-field reads are exactly that class of bug. Add a ratcheted `deno check` job (money-path functions first) and make the Stripe handlers resolve subscription id + `current_period_end` from the basil locations with fallbacks. Ship the CI gate before/with the Stripe fix. *(Verify the Stripe endpoint's pinned API version in the Dashboard first — P1-8 is DISPUTED.)*

### Slice J — Stop the academy-Mollie fallback misroute and page unbounded money/scale queries `[P1-9, P1-7, P2-16]`
An academy slot's revenue can land in the trainer's personal Mollie when the academy isn't charge-ready; several unbounded 1000-row-capped queries silently under-report or mis-sync money. Refuse the trainer-fallback for academy slots, page the `invoiceSync` bookings fetch, and move `get-admin-stats` aggregation into SQL.

### Slice K — Close anon RLS/settings leaks and remaining tenancy/PII over-exposure `[P2-1, P2-2, P3-1, P3-2, P3-3]`
The anon "open cycles"/"open registrations" policies leak private staff `notify_admin_emails` and full settings; `trainer_profiles_safe` leaks draft trainers; the shared-trainer `guest_players` policy over-exposes PII cross-tenant; `get_player_locations` discloses foreign-guest presence. RLS/view scoping fixes: interpose form-safe `_public` views, add `is_public`/`TO authenticated`/column filters, and scope the player argument. *(Confirm with product whether shared-trainer guest sharing is intended before narrowing P2-2.)*

### Slice L — Hygiene batch `[P3-6, P3-7, P3-10, P3-9, P2-14, P2-13, P3-11]`
Low-severity, independent cleanups: key the `send-email` public-form limiter on the trusted last XFF hop, make the read-modify-write limiters atomic, move the hardcoded foreign anon JWT to an env secret, page `notify-followers`, invalidate invoice/player caches after cycle mutations, detect invoice price changes by stable identity, and add the missing EN i18n key. Bundle or split by area as convenient.

---

## 5. Coverage appendix

### What was audited (all covered)
- **Money paths:** Mollie charge creation (all 8 `create-*-payment`/`create-*-invoice` fns + `_shared/guest-payment`, `mollie-payment-ready`, `registration-pricing`, `event-registration-invoice`); webhook + confirmation (`mollie-webhook`, `verify-mollie-payment`, `mollie-callback`, `_shared/mollie-webhook-*`, `mollie-booking-paid-side-effects`, `payment-audit`, `mollie-idempotency`); invoice mint/sync/split (`invoiceSync`, `invoiceCalc`, `invoiceSplitPricing`, `splitDivisor`, `split-invoice`, `recalculate-invoices`, `sync-invoice-to-bookings`, `generate-cycle-commitment-invoices`, `cycle-commitment-invoicing`); booking write path (`bookings`, `slotBookingWrite`, `bookForPlayerBooking`, `bookingPricing`, `cycleRoster`, `bulkCycleBookings`, `book_slot_for_payment` RPC).
- **Concurrency & races:** capacity/overbook, M-17 unique indexes, priority-claim races, `expire-lapsed-*` crons, webhook-vs-user races, cron overlap/re-entrancy, read-modify-write lost updates.
- **Security:** edge-fn internal auth / IDOR across the high-risk `verify_jwt=false` set; RLS reconstruction per sensitive table across migrations; SECURITY DEFINER RPC ownership checks; token/link generation + entropy + expiry + single-use; rate limiting on unauthenticated endpoints; CORS/CSP/headers; secret scanning.
- **Multi-tenant isolation:** cross-academy read/write via RPCs, views, and edge fns.
- **Data integrity:** FK/CASCADE hazards, orphan vectors (`booking_ids` array), nullable-treated-as-non-null, migration re-run safety, enum/status drift.
- **Scalability:** unbounded queries, N+1, missing hot-filter indexes, client fetch-everything, edge-fn timeout/memory, email/campaign batching.
- **Reliability:** silent catch-and-continue, unawaited promises, partial-failure/compensation, non-idempotent retries, silent cron death.
- **Frontend:** stale react-query cache, async UI races, i18n (hardcoded strings + nl/en divergence), public-page data leaks.
- **Supporting:** CI gates (root `tsc` files:[], `deno test --no-check` scope, vitest), tests-that-mock-the-thing, config drift.
- **Completeness-critic sweep:** Stripe subscription path, refund handling, admin fns (`get-admin-stats`, `impersonate-user`, `admin-reset-password`), `public-api`, `forward-invoice`, campaign/digest email abuse, Google-Calendar OAuth, `reditus-referral-webhook`, `resend-webhook` signature, `bulk-update-vat`, account deletion, silent pg_cron jobs.

### Candidate findings tested and REFUTED (shown for transparency)
Six candidates were adversarially refuted with a concrete blocking guard/path and are **excluded** from the findings above:
1. *"mollie-webhook amount guard skipped when summed booking amount is 0"* — REFUTED: every function that writes `metadata.booking_ids` also sets a positive `payment_amount` on exactly those bookings in the same flow, so no booking with null/0 `payment_amount` reaches the paid webhook via metadata. (Legitimate P3-worthy defensive weakness — guard fails open on zero-sum — but not an exploitable defect today.)
2. *"Split-count invoice rebuild bills every session at the first slot's price"* — REFUTED: no write path produces heterogeneous per-slot `price_per_session` within a cycle — the slot-detail price editors are hard-gated `if(!isCycleSlot)`, `update_cycle_pricing` forces uniformity, and all creation/rebook paths write a uniform price. `firstSlot.price_per_session` equals every slot's price.
3. *"`invoices.booking_ids` has no referential integrity → dangling ids in paid invoices"* — REFUTED as a live failure: the premise is true (bare `uuid[]`, no FK) but every current consumer (`reconcile_payments`, sync paths) joins `bookings` and tolerates absent rows; no code path fails on a dangling id. Latent schema hygiene, not a current defect.
4. *"`useAdminData` pulls entire profiles/user_roles into the browser and truncates at 1000"* — REFUTED: the specific truncation mechanism claimed doesn't apply to that hook's call shape. *(Note: `get-admin-stats` (P2-16) is a genuinely distinct, confirmed truncation on the server side.)*
5. *"webhook + verify skip paid-amount verification when summed `payment_amount` is 0/NULL"* — REFUTED: duplicate of #1's mechanism; the routing guard means a null/0-amount booking never reaches the amount branch via metadata.
6. *"`respond_to_priority_claim` single-claim accept can double-occupy vs a non-strict booking"* — REFUTED: the finding's own scenario requires an insert path that skips the advisory lock or ignores `payment_pending`, and no such path exists — every `bookings` insert passes through the guarded RPCs.

### Not covered / needs a live-prod check (cannot verify read-only)
- **P0-1 gateway precondition:** whether the Supabase hosted gateway independently rejects a request lacking a *valid* `apikey` (line 95 requires `bearer == apikey`). The forged token satisfies `bearer == apikey` by construction, and `mollie-webhook` receiving unauthenticated external POSTs strongly suggests the gateway forwards them — but the exact gateway behavior is a platform config not observable from source. **Treat P0-1 as exploitable until proven otherwise on a live probe.**
- **P1-8 (Stripe):** the payload shape depends on the API version pinned on the Stripe **webhook endpoint** in the Dashboard, not the SDK constructor — check it live before prioritizing.
- **P1-1 (Google OAuth):** whether the Google OAuth app is in Testing vs Published mode (Dashboard) affects who can complete the attacker consent step; the code defect stands regardless.
- **P3-9 / P1-7 / P2-16 (PostgREST 1000-row cap):** the exact `db.max-rows` / PostgREST default in the live project — assumed 1000 (Supabase default, no repo override found). The truncation defects are correct if the default holds; verify the live setting.
- **Storage-bucket readability for P0-2:** whether the `backups` bucket is publicly/broadly readable determines whether P0-2 is "unauthorized snapshot" vs "full exfil". Either way the unauthorized write is confirmed; the read exposure needs a live bucket-policy check.
- **Deno/Deploy runtime limits** (memory/time ceilings) for the unbounded edge fns (`get-admin-stats`, `send-campaign-emails`, `backup-database`) — the truncation/undercount is confirmed from source; the OOM/timeout tail depends on live volume and runtime limits.

### Method notes / self-imposed caps
- No coverage cap was silently applied to *subsystems* — every checklist dimension had at least one dedicated finder plus a second-wave deepen pass on the four highest-risk areas (money reconciliation, concurrency, RLS/tenancy) and a completeness critic. The loop ran two waves; the second wave's completeness critic surfaced new areas (Stripe, refunds, account deletion) that became confirmed findings, so a third full wave was not run — the marginal return had dropped to the completeness critic finding nothing structurally un-probed. If exhaustiveness beyond this is required, the untested-deeper corners are: the full `public-api` surface parameter-by-parameter, the blog-generation/AI-gateway spend paths, and the e2e/playwright fixtures (audited for CI-gating only, not for their own correctness).
- Per-finding `file:line` are from the current tree (HEAD `3665e7d4`). A few reporter line numbers were corrected during verification (noted inline, e.g. P1-3's live definition is in `20260612140000`, not the earlier v3 migration).
