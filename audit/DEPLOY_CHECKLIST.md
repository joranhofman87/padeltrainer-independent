# Owner Deploy Checklist — pre-scale hardening

Things that **do NOT auto-deploy** (only the Vercel frontend does). Apply these to the
live project `ficwbdrzefmblkbkomzw` after the matching PR merges.

> **Current state (verified 2026-06-28):** all migrations are LIVE and all edge functions are
> CURRENT **except the 6 deferred AI-gateway functions** — see the two reconciliation sections
> below. The dated `[x]`/`[ ]` markers in the lower sections are the historical audit trail; the
> two "verified 2026-06-28" sections are authoritative.
>
> **Foundation Tier A (PRs #187 · #188 · #189, merged 2026-06-28):** see the dedicated section
> immediately below — A1 capacity migration LIVE; `mollie-webhook` + `verify-mollie-payment`
> redeployed from `main` (post-merge); #187 is frontend-only.

## ✅ Foundation Tier A — booking correctness (PRs #187 · #188 · #189 · #193) — COMPLETE 2026-06-28

The grounded Codex roadmap Tier A (booking-domain hardening) — **fully merged + live in prod**.
Each slice characterization/rehearsal-tested **and** adversarially reviewed before merge.

1. [x] **#187 — online-cycle payment exact-ids + orphan rollback** (`src/lib/cyclePayment.ts`).
  **Frontend-only — auto-deploys via Vercel.** No migration, no edge-fn redeploy
  (`create-mollie-payment` already accepts `bookingIds`).
2. [x] **#189 — staff/guest slot-capacity guard.** Migration
  **`20260702120000_enforce_capacity_for_staff_bookings.sql`** — LIVE (applied via
  `db push --linked` 2026-06-28; the same push also finally *recorded*
  `20260701130000` in remote history, fixing the earlier dashboard-apply drift). Additive —
  replaces the `enforce_booking_slot_tier` function body so capacity is enforced for all
  authenticated inserts; trigger DDL unchanged; no data change. `friendlyError` change is
  frontend (auto-deploys).
3. [x] **#188 — webhook can't resurrect a cancelled booking.** **DEPLOYED 2026-06-28 from `main`**
  (`mollie-webhook` + `verify-mollie-payment`). Adds the `status != 'cancelled'` write-back guard
  + a Slack alert when a paid payment lands on a cancelled booking.
  - *Deploy gotcha that bit us:* the FIRST redeploy ran from the A1 feature branch (`main` + A1
    only, NOT #188) and a `git pull` on stale `main` said "Already up to date", so the guard did
    NOT ship until the PRs were merged. **Always merge to `main` first, `git pull`, then deploy.**
    Proof the re-deploy shipped it: `verify-mollie-payment`'s upload manifest now includes
    `_shared/mollie-webhook-payment.ts` (only imported once #188 added `findCancelledPaidBookings`).
  - Commands: `supabase functions deploy {mollie-webhook,verify-mollie-payment} --project-ref ficwbdrzefmblkbkomzw`

4. [x] **#193 — capacity-count allowlist alignment.** Migration
  **`20260702140000_capacity_count_allowlist.sql`** — LIVE (applied via `db push --linked`
  2026-06-28). Flips all **five** DB capacity counts (enforce_booking_slot_tier,
  book_slot_for_payment, respond_to_priority_claim ×2, swap_member_booking) from the denylist to
  the `CAPACITY_OCCUPYING_STATUSES` allowlist so `rejected`/`completed` no longer count toward a
  slot's occupancy (== app == index predicate). Function-body replace only; no data change. The
  adversarial review caught swap_member_booking as a fifth, missed site — folded in.

This closes the Tier-A follow-up; every server capacity count now agrees with the app + the
`idx_bookings_slot_status` predicate.

## ✅ P0 — single-slot online booking double-insert (PR #183) — DEPLOYED 2026-06-28

Codex foundation-verification Finding 1. The frontend half (the page no longer inserts
the booking) auto-deployed via Vercel; the two backend items restored the player's `notes`.

1. [x] Migration **`20260701130000_book_slot_for_payment_notes.sql`** — applied (verified:
  `book_slot_for_payment` now has the 4-arg `_notes text DEFAULT NULL` signature).
2. [x] Redeployed **create-mollie-payment** — forwards `notes`; deploy-gap-resilient
  (retries the 3-arg RPC on `PGRST202`/`42883`).

## ✅ Live-vs-pending reconciliation (verified 2026-06-28) — Codex Finding 4

`supabase db push --dry-run --linked` (owner-run, 2026-06-28) reported **only one migration
pending: `20260701130000…`** — now applied. **Every other migration in this file — including
Phase 4 · C + E and `academy_invoice_email_message` — is already LIVE.** The migration side is
fully reconciled: for migrations, "merged in repo" == "live in production". (The `[ ]`
markers below predate this dry-run; trust this section.)

The dry-run does **not** cover edge functions (no pending-tracker). Confirm edge-fn deploy
state with `supabase functions list` (below). Owner-deferred: the AI-gateway functions.

### Verification commands (owner; `--linked` after `supabase link --project-ref ficwbdrzefmblkbkomzw`)

    supabase migration list --linked       # Local vs Remote → a Local-only row is unapplied
    supabase db push --dry-run --linked     # previews pending migrations; applies nothing
    supabase functions list --linked        # compare each UPDATED_AT to its PR merge date

**Stop and investigate** if `migration list` / `db push --dry-run` ever shows an *unexpected*
migration (one you did not just merge) — that signals drift between repo and prod.

### Edge functions — CONFIRMED via `supabase functions list` (2026-06-28)

Every edge function whose code changed this cycle is deployed **after** its change landed —
prod matches repo:

| Function(s) | Live version | Deployed (UTC) |
|---|---|---|
| `create-mollie-payment` | v15 | 2026-06-27 14:41 |
| `mollie-webhook` · `verify-mollie-payment` · `create-invoice-payment` · `finalize-proposals` · `send-campaign-emails` | — | 2026-06-27 11:23 |
| `submit-guest-intake` · `create-registration-invoice` | — | 2026-06-27 09:26 |
| `create-group-rebook-invoice` · `send-rebook-group-confirmation` | v1 | 2026-06-25 14:38 |
| `bulk-rebook-cycle` · `send-rebook-reminder` · `send-priority-claim-invitation` | — | 2026-06-25 09:57 |
| `send-invoice-email` (PDF attach) | v20 | 2026-06-25 08:18 |
| `recalculate-invoices` · `generate-cycle-commitment-invoices` · `send-digest-emails` · `process-onboarding-emails` | — | 2026-06-25 08:18–19 |

**The only stale functions are the 6 AI-gateway ones — still v6 (2026-06-02), deferred by
owner decision** (see the AI-gateway section). Not a gap. ✅ Nothing left to deploy except if
you ever turn the AI features on.

## Edge functions to (re)deploy
`supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw`

- [ ] **staff booking notifications:** `supabase functions deploy mollie-webhook verify-mollie-payment send-email --project-ref ficwbdrzefmblkbkomzw` — on every PAID public booking (single/cyclus/cart, guest or logged-in) the trainer now gets an email WITHOUT the amount (bookings only, owner decision) and academy managers get one WITH the amount; both route through the `new_booking` notification preference (mute/digest per user), and a trainer who is also a manager gets only the academy version. Also fixes the logged-in player's booking-confirmation email (broken since launch: the invoke sent `template:` where send-email requires `type:` → silent 400) and removes the price from the approval-request trainer email. Deploy all three TOGETHER (webhook + verify bundle the shared side-effects; send-email carries the new template — an old send-email would 400 the new type, non-fatally).

- [ ] **academy trainer email change:** `supabase functions deploy update-user --project-ref ficwbdrzefmblkbkomzw` — academy/club managers may now change their trainers' LOGIN email (was admin/self only). Safeguards: notification to the OLD address (Resend), audit-logged in admin_impersonation_logs, email normalized lowercase. Deploy promptly after merge: until redeployed, an academy email edit shows success but silently does NOT change anything (the old fn ignores manager email).

- [ ] **retire generator drafts (migration, apply PROMPTLY after merge):** apply `20260711100000_open_generator_draft_cycles.sql` — one-time promotion of historical quick-generator drafts (settings->>generated_by='slot_generator' AND status='draft') to 'open'; slot visibility untouched (private drafts become open+private, the shape the generator now produces). Rebook half-build drafts are deliberately excluded (bulk-rebook-cycle uses draft as its rebuild marker — PGlite-tested carve-out). The same PR DELETES the frontend heal machinery (concept/already-live banners, publishCycle/openDraftCycles, bulk-visibility promotion), so any generator draft still lurking has NO in-app heal until this migration runs — apply right after the merge deploys.

- [ ] **rating edits unblocked (migration only, URGENT-ish — rating changes fail app-wide until applied):** apply `20260710100000_fix_rating_history_source_check.sql` — widens the player_rating_history source CHECK to include the 'profile'/'profile_reconcile' values the June sync trigger writes. Until applied, ANY skill_rating change (trainer dashboard, academy trainer editor, player profile, admin) aborts with the check-constraint error you hit. No frontend/edge-fn changes.

- [ ] **per-trainer public-page banner (migration only, ORDER-FREE):** apply `20260709100000_trainer_banner_url.sql` — adds `trainer_profiles.banner_url` + recreates `trainer_profiles_safe` to expose it (P-02 entitlement semantics byte-identical, PGlite-tested). No RLS/storage changes needed (academy-manager policies already cover the column and the `avatars/{trainer_user_id}/…` upload path). The frontend degrades gracefully pre-migration (public page falls back to the academy banner — anon-verified live; the editors' banner upload shows an error toast until applied), so merge/apply in any order — just apply promptly so banner uploads work.

- [ ] **trainer double-booking guard:** 1) apply migration `20260708100000_trainer_slot_overlap_guard.sql` — AFTER-row triggers on `availability_slots` refusing any INSERT (strict) or time-UPDATE (only NEWLY-created overlaps — pre-existing prod duplicate pairs stay shiftable/editable in lockstep, the guard never traps old data) that would put one trainer on court twice (`trainer_slot_overlap`, race-proof via per-trainer advisory lock). Also recreates `swap_slots` with its two UPDATEs merged into ONE statement (the proposal-grid drag-swap would otherwise trip the trigger on the intermediate state). 2) `supabase functions deploy bulk-rebook-cycle --project-ref ficwbdrzefmblkbkomzw` — new-round replication now dedupes twin series within a run and returns `reason: slot_overlap` (wizards show a clear message) instead of a generic 500 when the new term genuinely collides. Order-free vs the frontend merge (no new columns selected), but apply the migration and the fn deploy TOGETHER — with only the migration live, a colliding new-round shows a generic error instead of the mapped one. RECOMMENDED first: run the duplicate-detection query and clean up (delete/move one of each pair — they sell double!):
  `SELECT a.id AS slot_a, b.id AS slot_b, a.trainer_id, a.start_time, a.end_time, b.start_time AS b_start, b.end_time AS b_end FROM availability_slots a JOIN availability_slots b ON a.trainer_id = b.trainer_id AND a.id < b.id AND a.start_time < b.end_time AND b.start_time < a.end_time;`
  (`generate-proposals` also got a wider conflict pre-check in-repo; it is AI-gated and NOT deployed — it picks the fix up whenever the AI fns are ever enabled.)

- [ ] **whole_slot_booking (STRICT ORDER — the PR merges LAST):** 1) apply migration `20260707140000_whole_slot_booking.sql` (adds `availability_slots.whole_slot_booking` + loosens the `single_booking_not_allowed` guard in `book_guest_slot_for_payment` and `book_guest_cart_for_payment`; capacity/pricing untouched; split sessions stay locked — #352). 2) `supabase functions deploy create-guest-slot-payment create-guest-cart-payment bulk-rebook-cycle` (early-guard + selects + slot-replication carry the column). 3) ONLY THEN merge the PR — the new frontend selects the column; pre-migration it would blank ALL public availability (PostgREST 42703 swallowed by the hook).

- [ ] **create-guest-cart-payment** (cart recipient-key loosening) — the cart's one-recipient rule is now the PAYMENT recipient: different trainers of ONE academy may share a cart (money routes to the academy's Mollie); unrelated trainers/academies (different Mollie/invoicing) stay blocked. Bundles the updated `_shared/cart-payment.ts` (recipient key + per-trainer hourly fallback rates). *Grace window:* until this redeploys, a same-academy multi-trainer cart passes the CLIENT rule but gets `mixed_recipient` at checkout (graceful toast, guest can split) — deploy promptly after merge.

- [ ] **create-guest-cyclus-payment** (cyclus-booking toggle) — new server guard: a cycle with `settings.allow_cyclus_booking=false` refuses the whole-series checkout (`cyclus_not_bookable`). Deploy BEFORE running the RL Padel data flip below (the dialog hides the option, but this endpoint is verify_jwt=false — the guard is the authoritative rule). No migration.
- [ ] **RL Padel Performance data flip (owner SQL, run AFTER the fn deploy + frontend deploy)** — Yari de Jong + Tygho Schoonus: individual sessions ON, whole-cyclus OFF. Verified pre-flight: all 116 affected future slots have ZERO bookings/holds; per-seat price becomes `price_per_session ÷ max_participants` (€76.50 ÷ 4 = **€19.13/seat/session**).
  ```sql
  -- 1) individual booking ON for their future cyclus sessions
  UPDATE public.availability_slots
  SET allow_single_booking = true
  WHERE trainer_id IN ('6c78e40a-24fc-4b93-bc92-bf42559a0cb6',  -- yari-de-jong
                       'e59582d7-f07a-4864-9e6d-5e1cd47871c5')  -- tygho-schoonus
    AND cyclus_id IS NOT NULL
    AND start_time > now();
  -- 2) their cycles: individual ON + whole-cyclus OFF (drives the dialog, the edge-fn
  --    guard, and any future slots generated from these cycles)
  UPDATE public.cycles
  SET settings = COALESCE(settings, '{}'::jsonb)
             || '{"allow_single_booking": true, "allow_cyclus_booking": false}'::jsonb
  WHERE id IN (
    SELECT DISTINCT cyclus_id FROM public.availability_slots
    WHERE trainer_id IN ('6c78e40a-24fc-4b93-bc92-bf42559a0cb6',
                         'e59582d7-f07a-4864-9e6d-5e1cd47871c5')
      AND cyclus_id IS NOT NULL
  );
  ```

- [x] **create-guest-cart-payment** (cart booking PR 2) — **DEPLOYED 2026-07-05** (after the PR-1 migration). Anon-probed live: `{}` → 400 `slots_required`; unknown slot id → 409 `slot_unavailable` **with `slotIds`** (the cart prune contract works in prod; validation refuses before any hold). NEW public fn (verify_jwt=false): guest multi-session cart pay-first, calls `book_guest_cart_for_payment`.
- [x] **mollie-webhook**, **verify-mollie-payment** (cart booking PR 3) — **DEPLOYED together 2026-07-05**; both upload manifests included `_shared/mollie-booking-paid-side-effects.ts` (proof the fix shipped, per the #188 manifest check). Guest confirmation email fix (public-booking audit P1-5): guests get the invoice email on the paid transition (players unchanged) + Slack `payment_received` now fires for guest payments. *Behavior change live: ALL guest pay-first flows (single-slot, cyclus, cart) email guests.*
- [x] **update-user** — IDOR fix (#77). *Security — do this one first.*
- [x] **stripe-subscription-webhook**, **og-image**, **rating-og-image**, **get-public-rating**, **health-check** — redeploy so prod matches the new `config.toml` `verify_jwt=false` (#78). Prevents a future deploy from 401-ing them.
- [x] **send-email** — HTML-injection escaping for registrant text (#80). *Security — closes the public submit-guest-intake → cross-tenant admin email injection vector.*
- [x] **send-campaign-emails** — resumable + accurate sent counts (#80). Stops silently dropping the unprocessed tail on timeout / marking failures as sent.
- [x] **send-campaign-emails** — autonomous resume: service-role chain + daily sweep (#81). Ships `config.toml verify_jwt=false` for this fn (so the sweep cron isn't 401'd) — redeploy required. The `daily-maintenance` cron change auto-deploys via Vercel.
- [x] **send-campaign-emails** — bounded failed-recipient retry (#82). **Migration below applied FIRST**, then redeployed.
- [x] **auto-create-invoice**, **create-registration-invoice**, **create-rebook-invoice** — Slack alert on the money-path catch (#83). Closes silent server-side invoice-mint failures. Needs the `slack-notify` webhook already configured (it is — other fns use it).
- [x] **submit-guest-intake**, **create-registration-invoice** — registration date-span lesson count now FLOORED, not rounded (#86). *Money change — fixes a one-lesson over-charge on non-exact-week date-span cycles.* These bundle the fixed `_shared/registration-pricing.ts`.

## Migrations to apply  *(all LIVE as of 2026-06-28 — `db push --dry-run` shows nothing pending)*
- [x] **`20260707100000_book_guest_cart_for_payment.sql`** (cart booking PR 1) — **APPLIED 2026-07-05** via `db push --linked`. New `book_guest_cart_for_payment` RPC (guest multi-session cart holds; clone of the cyclus RPC with single-slot per-item guards + id-carrying errors). `types.ts` deliberately NOT regenerated (service-role-only RPC; regen would drag the stale-since-#273 diff).
- [x] **Phase 4 · C + E** — LIVE. see `docs/PHASE4_CE_INTEGRITY_INDEX_RUNBOOK.md`. Two additive, idempotent, non-destructive migrations:
  - **`20260630120000_phase4_C_cyclus_id_fk.sql`** — adds FK `availability_slots.cyclus_id → cycles.id` **NOT VALID** + `ON DELETE SET NULL`. Stops any NEW orphan slot group at the DB. Existing orphans untouched; clean them up + `VALIDATE` later via the runbook's STEP 2 (pre-flight count → run the prepared backfill `20260612230000` → validate). After applying, **regenerate `types.ts`** (the PR hand-adds the matching FK relationship so the drift gate stays green; regen confirms).
  - **`20260630120100_phase4_E_invoices_booking_ids_gin.sql`** — GIN index on `invoices.booking_ids` so the invoice-sync `.overlaps()` lookups stop sequential-scanning. Plain `CREATE INDEX` (txn-safe); use the runbook's `CONCURRENTLY` form first only if invoices is large.
- [x] **`20260624130000_email_campaign_recipient_attempt_count.sql`** (#82) — adds `email_campaign_recipients.attempt_count`. Additive + backward-compatible; applied before redeploying send-campaign-emails.
- [x] **`20260625120000_academy_invoice_email_message.sql`** — LIVE. adds nullable `academy_profiles.invoice_email_message` (the "Save as default" invoice-email template). Additive + backward-compatible.

## Config / dashboard
- [x] `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` set in Vercel **Production** (verified).
- [x] Production error monitoring — **resolved**: PostHog `$exception` (client) + Slack alerts (cron + critical edge fns) cover it; no Sentry needed (#83, see `audit/MONITORING.md`).

## ✅ Invoice PDF — DEPLOYED (send-invoice-email v20, 2026-06-25)

- [x] **send-invoice-email** — **attaches the invoice PDF** to the payment email (best-effort: it calls `generate-invoice` for a fresh signed `pdfUrl`, fetches it, and attaches base64; if generation fails it still sends the pay-link email). Live at v20 (2026-06-25). *(If unsure the attach works, send yourself a test invoice email and check for the PDF.)*

## 🟡 DEFERRED by owner — replace the Lovable AI gateway (P1 #9)

> **Status 2026-06-28:** all 6 still at **v6 (2026-06-02)** — intentionally NOT redeployed (the AI
> admin features aren't needed now and they require the secrets below). This is the only group not
> current with the repo, and it's by choice. `generate-proposals` is AI-gated and no-ops without the
> gateway, so the `.eq` fix bundled in it has no live effect until you enable the gateway anyway.

The 6 AI edge fns no longer hardcode `ai.gateway.lovable.dev` / `LOVABLE_API_KEY`. They now use the
shared `_shared/ai-gateway.ts`, driven by env (any OpenAI-compatible `/chat/completions` gateway).
**Set the secrets BEFORE redeploying** — otherwise the AI features throw (content tools) or skip
(the gated ones):

`supabase secrets set AI_GATEWAY_BASE_URL=<gateway, e.g. https://openrouter.ai/api/v1> AI_GATEWAY_API_KEY=<server-only key> --project-ref ficwbdrzefmblkbkomzw`

Optional overrides: `AI_GATEWAY_TEXT_MODEL` (default `google/gemini-2.5-flash`), `AI_GATEWAY_IMAGE_MODEL` (default `google/gemini-3-pro-image-preview`).

Then `supabase functions deploy <name> --project-ref ficwbdrzefmblkbkomzw` for:
- [ ] **enrich-clubs**, **scrape-academies**, **generate-proposals** — gated on `isAiGatewayConfigured()`; skip gracefully if unset.
- [ ] **generate-blog-article**, **translate-blog-article**, **generate-blog-cover** — admin content tools; throw if unset (same as the old `LOVABLE_API_KEY` behaviour).

The `_shared/cors.ts` lovable-origin removal bundles into every fn deploy; the `daily-maintenance`
comment-only change auto-deploys via Vercel. Delete `LOVABLE_API_KEY` from the project secrets once
all 6 are redeployed.
## ✅ Batch-job correctness (P1 #11) — DEPLOYED 2026-06-25

- [x] **recalculate-invoices** (v8, 2026-06-25) — bounds the unscoped "recalc everything" path at `MAX_UNSCOPED = 2000`. *No behaviour change for scoped (invoice_ids) calls.*
- [x] **generate-cycle-commitment-invoices**, **send-digest-emails**, **process-onboarding-emails** (2026-06-25) — per-failure Slack alerting on the batch jobs. These return HTTP 200 even when individual items fail (a committer not billed / a digest or onboarding email not sent), so the daily-maintenance / daily-emails cron wrappers' `alertCronFailure` (non-2xx only) never surfaced them. Each fn now raises **one** `notifySlackEdgeError` per run when its partial-failure count is > 0. Needs the `slack-notify` webhook already configured (it is). *Observability only — no behaviour change to the happy path.*

## Notes
- The CI changes (rehearsal runner, edge-fn config guard, cron Slack alerts, stale-ref purge) took effect on merge — no manual deploy.
- Dependency-vuln upgrade: the production-runtime fixes shipped (#84, react-router + protobufjs); the dev/build + Vercel-runtime remainder is documented as deferred in `audit/DEPENDENCIES.md`.
- Remaining scoped follow-up (no deploy): the code-level frontend↔Deno pricing dedup — `audit/PRICING_DEDUP.md`.
