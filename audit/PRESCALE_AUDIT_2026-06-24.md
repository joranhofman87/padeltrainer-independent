# PadelTrainer — Pre-Scale Go/No-Go Audit

**Date:** 2026-06-24 · **Scope:** Readiness to invite many more trainers/academies/players · **Repo:** `/Users/tom/Cursor/padeltrainer`

---

## 1. Executive Summary

The money- and capacity-critical core of PadelTrainer is unusually well-hardened, and the recent audit waves clearly landed: payment webhooks re-fetch and amount-verify against Mollie, invoice numbering is atomic with academy-scoped uniqueness, overbooking is closed with per-slot advisory locks, admin/edge functions are role-gated, public token endpoints are revocation-aware, and player writes to financial columns are blocked by SECURITY DEFINER triggers. There is **no confirmed P0 in the security, RLS, cross-tenant, or money-correctness *runtime* layer.** However, the audit surfaces a different and decisive class of P0: **the safety net is not wired into CI, key batch jobs fail silently, one bulk-email path drops recipients while reporting success, and a routine `functions deploy` will silently 401 the Stripe webhook and all social-share images.** These are exactly the failure modes that stay invisible at low volume and bite the moment you scale.

**Verdict: NOT READY — fix the P0 list below first (most are 1–2 day fixes), then GO.**

The single most important reason: **the regression nets that prove your money/capacity invariants (PGlite rehearsals, Deno edge tests) exist and pass but run in zero CI jobs** — so the very protections this go/no-go relies on can silently regress to green, and you are about to multiply the change rate and the blast radius simultaneously.

---

## 2. Gate Results

| Gate | Check | Status | Notes |
|------|-------|--------|-------|
| 1 | `tsc --noEmit` (frontend typecheck) | ✅ PASS | 0 errors. Edge functions (Deno) not covered. |
| 2 | `npm run lint` (eslint) | ✅ PASS | 0 errors / 0 warnings across `src/`. |
| 3 | `vitest run` | ⚠️ FLAKY | 1537/1538 pass. Sole failure = a 5000ms parallel-load timeout on `AdminSidebar.test.tsx` (passes in 1.47s isolated). Not a regression — but a flaky go/no-go gate. |
| 4 | `npm run build` (vite) | ✅ PASS | 15.39s. 578kB main-chunk warning (P2 perf). |
| 5 | `npm run i18n:check` | ✅ PASS | nl: 0 missing. |
| — | Deno `deno check` edge fns | ⏭️ SKIPPED | No deno toolchain locally. **Whole payment/invoice tier is untyped in CI.** |
| — | Playwright e2e | ⏭️ SKIPPED | Browsers/server not available in audit env. |

---

## 3. Launch Blockers (P0)

### P0-1 · A routine `functions deploy` silently 401s the Stripe webhook and every social-share image
**What:** 22 edge functions exist on disk with **no entry in `supabase/config.toml`**. Functions absent from config inherit the platform default `verify_jwt=true`, so the gateway rejects unauthenticated callers before the function runs. Three of the 22 are called with **no Supabase JWT**: `stripe-subscription-webhook` (authenticates by Stripe signature only — `index.ts:37`), `og-image` (`index.ts:30`), and `rating-og-image` (`index.ts:10`).
**Why it blocks:** A full `supabase functions deploy` arms a latent outage — Stripe subscription state stops syncing (billing drift) and every Facebook/LinkedIn/WhatsApp/Twitter share preview breaks — right as you ramp growth. `config.toml` was last edited 2026-06-24 while `og-image` (created 06-12) and the webhook (06-14) were never added: active drift, not legacy.
**Files:** `supabase/config.toml`, `supabase/functions/stripe-subscription-webhook/index.ts:37`, `supabase/functions/og-image/index.ts:30`, `supabase/functions/rating-og-image/index.ts:10`, `src/components/SEO.tsx:132`, `src/pages/marketing/PublicRatingCard.tsx:86`.
**Fix:** Add explicit `[functions.<name>] verify_jwt = false` for `stripe-subscription-webhook`, `og-image`, `rating-og-image`, `get-public-rating`, `health-check`. Triage the remaining 17 deliberately. Add a **CI check that fails if any dir under `supabase/functions/` (except `_shared`) lacks a config entry** so drift can't recur.
**Test:** In CI assert every function dir has a `config.toml` block. Integration: `curl -sI .../functions/v1/og-image` and `.../rating-og-image` with **no Authorization header** must return 200 image; an unsigned POST to `.../stripe-subscription-webhook` must reach signature verification (400 "Missing stripe-signature"), **not** a gateway 401.

### P0-2 · Money/security PGlite rehearsals exist and pass but run in NO CI job
**What:** `db:rehearse:all` (the CI "Data-integrity rehearsals" step, `test.yml:54`) chains only 8 of 28 rehearsals — all read/list/delivery flows. The most dangerous money/capacity rehearsals are referenced by no npm script and run nowhere: `rehearse-recalc-split`, `rehearse-capacity-locks`, `rehearse-split-payment-trigger`, `rehearse-stripe-idempotency`, `rehearse-m10-invoice-numbering`, `rehearse-booking-tier-update`, `rehearse-rebook-group-claims`.
**Why it blocks:** These are real golden-master tests (verified: each loads the *actual* migration SQL and asserts the invariant — e.g. recalc-split asserts split count == unique-active-players AND paid invoices are never re-split). They pass today. Because nothing runs them, a regression to `recalc_cycle_split_count`, the split trigger, atomic invoice numbering, or capacity locks **ships green**. For a pre-scale money go/no-go, this is the regression net you cannot launch without.
**Files:** `package.json` (`db:rehearse:all` chain), `.github/workflows/test.yml:50-54`, `scripts/db/rehearse-recalc-split.mjs`, `scripts/db/rehearse-capacity-locks.mjs`, `scripts/db/rehearse-m10-invoice-numbering.ts`, `scripts/db/rehearse-stripe-idempotency.mjs`.
**Fix:** Add the 7 orphaned rehearsals to `db:rehearse:all` (run `.ts` ones via `tsx`). Add a tiny guard that fails CI if any `scripts/db/rehearse-*.{mjs,ts}` is referenced by no npm script.
**Test:** Break `recalc_cycle_split_count` (drop the paid-invoice guard) on a branch; confirm CI now goes RED. Regression case: cycle with 3 active players + 1 PAID sibling invoice → unpaid split_count becomes 3 while the PAID invoice stays 1.

### P0-3 · `send-campaign-emails` drops recipients mid-run and unconditionally marks the campaign "sent"
**What:** Claims **every** pending recipient in one UPDATE with no LIMIT (`index.ts:173`), then sends serially: per recipient an `await fetch` to Resend + a row UPDATE + `setTimeout(200ms)` (`:205-258`). No wall-clock budget, no self re-invocation. Edge functions are hard-killed at the wall-clock limit, so a campaign over ~150–200 recipients is killed mid-loop, stranding claimed rows in `status:'sending'` with nothing to resume them. After the loop it unconditionally sets `status:'sent'` (`:277`). The UI fires-and-forgets the invoke and immediately toasts "campaign sent."
**Why it blocks:** A club emailing its full member list — the exact behavior you're inviting more clubs to do — silently loses recipients while the operator is told it succeeded. Money/comms path running blind under the load you're about to add.
**Files:** `supabase/functions/send-campaign-emails/index.ts:173, :205, :248, :277`.
**Fix:** Mirror `notify-followers/index.ts:174-182` (already in the repo): add `TIME_BUDGET_MS` (~110s) + bounded-concurrency chunks, drop the per-email sleep, leave un-sent rows as `pending` (not `sending`) and re-invoke. Only write `status:'sent'` when a COUNT of non-terminal recipients for the campaign is 0.
**Test:** Seed 1,000 recipients, invoke once. Assert: returns within timeout; no recipient stuck in `sending`; campaign marked `sent` only when 0 remain pending; a second invoke resumes the remainder without re-sending any `sent` row.

### P0-4 · Daily Vercel crons fail silently — no alert when billing, backups, or emails break
**What:** Both `daily-maintenance` and `daily-emails` swallow per-job errors into a results map and return `200/207` that nobody reads (`daily-maintenance.ts:29-42`, `daily-emails.ts:26-39`). No Slack/Sentry/PagerDuty/heartbeat anywhere in `api/` (grep = empty). Vercel does not page on cron non-2xx. So a failed nightly backup, a stalled rebooking-invoice minter, or a thrown digest job is invisible until an academy complains; the child edge logs are ephemeral.
**Why it blocks:** This gates the exact decision in scope — onboarding many paying academies — and runs the product's **money path (deferred rebooking-invoice minting) and backups blind.** A silent multi-day backup failure at scale is real data-loss exposure. (Boundary P0/P1: the crons run correctly today; the gap is detection. Held at P0 because of what runs blind.)
**Files:** `api/cron/daily-maintenance.ts:29-42`, `api/cron/daily-emails.ts:26-39`, `api/_lib/cron.ts:55-83`.
**Fix:** On `!allOk`, call the existing `slack-notify` (event `edge_function_error`) with the failing slugs before returning — the service key is already in scope. Add a positive **dead-man's-switch heartbeat** (healthchecks.io/cronitor) so a cron that *never fires* also alerts. Optionally persist a `cron_runs` row for an admin health view.
**Test:** Point `backup-database` at a non-existent bucket (forces 500), trigger `daily-maintenance` with the CRON_SECRET; assert 207 **and** a Slack alert naming `backup-database`. Then disable the schedule and assert the heartbeat monitor flips DOWN within its grace window.

### P0-5 · Money/security edge-function (Deno) tests run in NO CI workflow
**What:** `vitest.config.ts:11` scopes collection to `src/**`, so the 10 Deno tests under `supabase/functions/` are never collected, and no workflow runs `deno test` (grep = none; deno isn't even installed). The untested-in-CI tests cover the riskiest boundaries: `create-invoice-payment`, `get-booking-invoice` (cross-tenant invoice access), `_shared/auth.ts` (service-role/JWT gates), `mollie-payment-ready`, `send-priority-claim-invitation`, `generate-proposals`.
**Why it blocks:** These are the server-enforcement points the whole hardening effort was about. A future regression — e.g. dropping the anon-key rejection in `get-booking-invoice` — ships green and could leak invoices cross-tenant.
**Files:** `vitest.config.ts:11`, `supabase/functions/get-booking-invoice/index.test.ts`, `supabase/functions/_shared/auth.test.ts`, `supabase/functions/create-invoice-payment/index.test.ts`.
**Fix:** Add a pinned `setup-deno` + `deno test --allow-env --allow-net=none supabase/functions/` job as a **required PR check.** At minimum gate `_shared/auth` + `mollie-payment-ready` + the invoice/booking-access tests.
**Test:** CI must fail the build if someone removes the anon-key guard in `get-booking-invoice` (the "rejects anon key as bearer" case).

### P0-6 · Unescaped attacker text injected into HTML emails from a public, unauthenticated endpoint (cross-tenant)
**What:** `send-email/index.ts` interpolates user-controlled strings (playerName, notes, phone) raw into nearly every HTML template; a `sanitizeForHtml()` helper exists (`:1147`) but is applied **only** to the partner-inquiry branch (`:1224`). `submit-guest-intake` is genuinely public (`config.toml:164` `verify_jwt=false`) and validates length only — passing `notes`/`phone`/`playerName` straight through. Those reach the **cross-tenant admin notification** `new_intake_registration_admin`, delivered to a *different* academy's staff inbox (`send-email/index.ts:924-934`).
**Why it blocks:** An anonymous attacker opening any academy's public registration form can inject phishing links, spoofed "confirm payment" buttons, and tracking pixels into that club's inbox — zero auth, and it scales with the number of clubs you invite. (Email clients strip JS, so this is HTML/link/phishing injection, not executing XSS → P0, not above.) The invoice path already escapes correctly via `esc()` (`generate-invoice/index.ts:68`), proving the pattern is known and just not adopted in the email layer.
**Refinement from verification:** the "forged subject via CR/LF" angle is **already mitigated** (`splitFullName` collapses whitespace; subjects render as plain text) — drop that emphasis. The live risk is the HTML body.
**Files:** `supabase/functions/send-email/index.ts:1147, :924-934`, `supabase/functions/submit-guest-intake/index.ts:111-141`, `supabase/functions/_shared/registration-confirmation-email.ts`.
**Fix:** Apply `esc()`/`sanitizeForHtml()` at every interpolation site of registrant-controlled fields (`notes`, `phone`, `playerName`) across all `send-email` templates and the shared confirmation composer. Keep `white-space:pre-line` on `confirmationText` but escape its text content.
**Test:** POST to `submit-guest-intake` (no auth) with `notes='<a href="https://evil.example">Confirm payment</a><img src="https://evil.example/x.gif">'` for a victim cycle; assert the delivered admin email HTML contains `&lt;a` / `&lt;img` (escaped), no live anchor/img tag.

---

## 4. P1 — Fix Before Broader Rollout

1. **`backup-database` silently truncates to ~1000 rows AND backs up only 15 of ~71 tables.** No `.range()` pagination, no `db_max_rows` override (`index.ts:40-41`); whole-table `JSON.stringify` (`:50`). Truncated upload still returns `ok:true`, so the "fail-loudly" guard reports green while saving partial data. The hand-maintained `TABLES_TO_BACKUP` (`:3-19`) omits `slot_priority_claims`, `cycles`, `invoice_status_history`, `email_delivery_events`, etc. No restore runbook or test exists. **Fix:** paginate + assert `row_count` vs `count(*)`; enumerate tables from `information_schema` (or a CI test that fails on a new untracked table); confirm Supabase PITR is the real DR mechanism; write + dry-run a restore runbook. *(Subsumes the P0-4 backup-alert concern on the alerting side.)*

2. **Booking-tier/capacity SECURITY enforcement is unverified in CI.** `tests/rebooking-enforcement.spec.ts:132` self-skips unless `RUN_REBOOKING_ENFORCEMENT=1` + service-role key (set in no workflow), AND the three PGlite rehearsals that exercise the same trigger (`rehearse-book-slot`, `rehearse-booking-tier-update`, `rehearse-capacity-locks`) are orphaned (overlaps P0-2). The SQL **priority-tier rejection branch** has zero automated coverage. **Fix (cheap):** extend `rehearse-booking-tier-update.mjs` to assert a non-claim-holder INSERT during the priority window is rejected while the claim-holder succeeds; wire it into `db:rehearse:all`.

3. **No PR-gated e2e coverage of any core flow.** `e2e.yml` runs only on a Sunday cron + dispatch, and its specs are non-destructive (route-mocked, no account/booking creation). Four authored specs (`auth`, `dashboard`, `admin`, `registration`) run nowhere. **No test at any cadence creates an account, books a slot, accepts a claim, or pays an invoice end-to-end.** **Fix:** add a PR-gated job that seeds → runs one real happy-path per top flow against a disposable/staging project → tears down. Prove it fails when the booking RPC or invoice minter is broken.

4. **RLS health check is a weekly, prod-only canary that only detects recursion.** `e2e/rls-health.spec.ts` runs against live prod (with a **hardcoded prod anon JWT + project ref** as fallback default, `:3-4`) and asserts only the absence of "infinite recursion" — never cross-tenant leakage. A recursion regression can sit unflagged for a week in production. **Fix:** move a recursion probe **+ a real two-tenant cross-tenant-leak probe** into a PR-gating job on the ephemeral local stack; remove the hardcoded prod defaults.

5. **Hand-duplicated money/name logic across the Vite↔Deno boundary; `profileName` has already drifted.** No shared-import mechanism exists, so `invoice-split-pricing.ts`, `booking-pricing.ts`, `profileName.ts` are maintained as byte-parallel copies with "keep in sync" comments. The split-pricing pair (preview vs charge) is still identical *today*, but a one-sided edit makes the price the client previews diverge from the price the edge function charges; `profileName` has already diverged (cosmetic). **Fix:** one canonical shared module both runtimes import, or a CI guard diffing normalized source. Add a parity unit test importing both split-pricing copies across a price matrix.

6. **Trainer-vs-academy = ~10 copy-pasted page pairs (~2,185 LOC of parallel invoice UI) with character-identical handler bodies.** Every invoice rule change must be made twice and has already diverged (status-badge rendering uses different models per owner). **Fix:** lift shared logic into `useInvoiceManagement({ownerType, ownerId})`, mirror the agenda pattern; one vitest proves the paid-guard for both owner types.

7. **Deferred billing cron drops per-invoice failures into ephemeral logs only.** `generate-cycle-commitment-invoices` returns `200 ok:true` even when a committer's invoice was silently skipped; `lateClaims` (left for "manual handling") appear only in an unread report. A rebooked player can simply never get billed with no alert. **Fix:** accumulate a `failures[]`, Slack-alert on any failure or `lateClaims>0`, surface created-vs-expected, and flip `ok:false` so the cron's `allOk` reflects it.

8. **Critical email crons (`send-digest-emails`, `process-onboarding-emails`) only `console.error` on failure.** No Slack on top-level or per-user failure; `send-digest-emails:272` knowingly logs "digest lost" to console only. The retry/claim logic is sound (no data loss), but silent repeated failure erodes trust with zero operator signal. **Fix:** `notifySlackEdge` on top-level catch; aggregate-then-alert-once above a per-user failure threshold (don't await per-user inside the loop).

9. **`recalculate-invoices`: unbounded platform-wide SELECT + per-invoice N+1, no scope/budget.** No-id path selects ALL draft/sent/pending invoices platform-wide with no `.limit()` (`:61-64`); rebuild path does per-invoice booking/cycle SELECTs. At tens of thousands of invoices it times out half-complete, leaving money fields partially recomputed (and may silently truncate to a row cap). Admin-gated/manual, so not P0. **Fix:** keyset-paginate with a budget + continuation cursor; batch-fetch bookings via one `.in('id', ids)`; gate the all-invoices path behind an explicit scope or confirmed full-rebuild flag.

10. **Daily digest + onboarding drip only run once/day; overflow waits 24h.** `send-digest-emails` caps the candidate fetch at 1000 rows and sends serially with no budget; `process-onboarding-emails` drains only 50/day. Beyond one invocation's capacity, digests are delayed (or rows >1000 silently dropped) and drips fall progressively behind. **Fix:** move both onto Supabase pg_cron hourly (pattern already proven in-tree); add `TIME_BUDGET_MS` + the single-flight lock to the digest job.

---

## 5. By Dimension — One-Line Health Verdicts

| # | Dimension | Verdict |
|---|-----------|---------|
| 1 | **Architecture & Maintainability** | 🟡 Navigable and recently consolidated, but Vite↔Deno hand-duplication (money/name) and ~10 copy-pasted owner-type page pairs are a reliability multiplier — every money/rule fix lands 2×. |
| 2 | **Core flow reliability** | 🟢 Backend enforcement on money/capacity is genuinely strong; 🔴 almost none of those invariants are guarded by CI (the dominant pre-scale risk). |
| 3 | **Security, RLS & Data Protection** | 🟢 Strong and deliberate — financial-column triggers, definer-helper tenant isolation, revocation-aware tokens, signed webhooks. No P0/P1 in the *runtime* layer; residuals are the email-injection (P0-6) and P2/NIT hardening items. |
| 4 | **Server-side protections vs client bypass** | 🟢 Money/capacity/financial columns hard to bypass; 🔴 the one real gap is the unescaped public-endpoint email injection (P0-6). |
| 5 | **Tests & CI** | 🔴 Large suite, but a load-bearing "exists-but-not-run" gap on money + RLS + edge-fn paths. Not go-ready until P0-2/P0-5 close. |
| 6 | **Observability & Operations** | 🔴 Respectable foundation (logger→PostHog, invoice-health-check, Slack on webhooks) but the money/email/backup batch jobs fail silently (P0-4) — the biggest ops gap. |
| 7 | **Performance & Scalability** | 🟡 DB layer solid (server-paginated RPCs, right indexes, lazy routes); edge-function fan-outs (`send-campaign-emails` P0-3, digests, `recalculate-invoices`) are the scaling cliffs. |
| 8 | **UX/UI Consistency & Mobile** | 🟡 Strong shared primitives and polished public pay/claim/registration flows; cosmetic gaps only — dual toast systems and half-adopted mobile tables (all P2). No money/auth UX risk. |
| 9 | **Migration & Deployment** | 🟡 Correctly repointed to ficwb; the `config.toml`/`verify_jwt` drift (P0-1) is the one real deploy landmine, plus stale docs. |

---

## 6. Missing Tests — Minimum Suite Before Scaling (riskiest first)

1. **CI cross-tenant invoice access (Deno, `get-booking-invoice`)** — assert a caller requesting an invoice whose booking belongs to a different academy/player is rejected (403/404). *Gates P0-5.*
2. **Split recalc money invariant (PGlite, `rehearse-recalc-split`)** — cycle with 3 active players + 1 PAID sibling invoice: unpaid `split_count` → 3, PAID invoice stays 1 (no retroactive re-split of collected money). *Gates P0-2.*
3. **Capacity overbooking under concurrency (`rehearse-capacity-locks`)** — two simultaneous claim-accepts on the last seat: exactly one succeeds, the other gets `slot_full`. *Gates P0-2.*
4. **Booking-tier priority-window enforcement** — non-claim-holder INSERT during the priority window is rejected; claim-holder succeeds; full slot rejected. *Closes the SQL priority branch gap (P1-2).*
5. **Atomic invoice numbering (`rehearse-m10-invoice-numbering`)** — concurrent mints produce strictly-increasing, per-academy-unique numbers; 23505 retry path holds.
6. **Stripe webhook idempotency (`rehearse-stripe-idempotency`)** — duplicate delivery + out-of-order events don't double-activate.
7. **Campaign email at scale (P0-3)** — 1,000 recipients: returns within timeout; no row stuck `sending`; `sent` only when 0 pending; resume doesn't re-send.
8. **Email HTML escaping (P0-6)** — `submit-guest-intake` with HTML/anchor/img in `notes` → delivered admin email HTML is escaped.
9. **PR-gated destructive happy-paths (P1-3)** — signup→onboard, book→pay (Mollie test mode), claim accept, guest-intake submit, each seeded + torn down.
10. **Two-tenant RLS leak probe (P1-4)** — academy-A authed session reads 0 rows of academy-B on `bookings`/`invoices`/`session_reports`/`profiles`/mollie token tables.

---

## 7. Operational Gaps to Close

- **Cron failure alerting + dead-man's-switch** (P0-4): Slack on `!allOk` from both crons; heartbeat so a never-fired cron also alerts.
- **Backup integrity + DR** (P1-1): confirm Supabase PITR is the authoritative recovery mechanism; fix silent truncation; write and dry-run a one-page restore runbook.
- **Edge log retention:** configure a Supabase log drain (Logflare/Axiom/Datadog) — edge logs are ephemeral, so post-incident forensics currently has no source.
- **Admin "System Health" surface:** thin admin page calling `health-check` (currently scheduled by no cron), last backup ok/timestamp, last invoice-health anomaly, recent bounce/complaint counts.
- **Stale pg_cron audit:** run `SELECT jobname, command FROM cron.job` on ficwb; assert no command contains the legacy `ppkbhdiiqdusdeatgdft` ref; document Vercel vs pg_cron authority per job. *(Downgraded to P2 — a 2026-06-06 migration already repoints the RPC bodies and the jobs were likely never scheduled on ficwb.)*
- **`rate_limits` TTL:** daily purge of rows older than the longest window (quiet scaling cliff).

---

## 8. Refuted / Downgraded (so you can trust the rest)

- **"Security/RLS migration tests are SQL string-greps with zero behavioral RLS coverage"** — **P1 → P2.** Premise partly true (4 named files are greps), but the conclusion is false: a behavioral two-tenant `SET ROLE authenticated` + settable `auth.uid()` RLS rehearsal **already exists and runs in CI** (`scripts/db/rehearse-coaching-notes.mjs`, asserts cross-player/cross-tenant isolation + INSERT-deny). The auditor missed `scripts/db/`. Residual: the two specific migration policies asserted only by grep deserve a behavioral replay — narrow coverage gap, not a blocker.
- **"`db reset` (real migrations + RLS) is path-filtered off most PRs → non-migration PRs get no DB validation"** — **P1 → NIT (refuted).** Missed `test.yml`, which runs on **every** PR with no path filter and executes `db:rehearse:all` (real migrations applied in PGlite + behavioral money/RLS assertions). The premise is false.
- **"Client-side invoice recalculation in `invoiceSync.ts` lets users tamper with totals"** — **P1 → P2.** Architecture/desync concern is real (665 LOC, raw client `invoices.update`, parallel server recompute), but the "tamper" rationale is refuted: players are blocked from financial-column writes by trigger + RLS; the only player-facing caller runs the divisor server-side under SECURITY INVOKER; remaining writers edit their *own* invoices. No cross-tenant/money-loss path.
- **Stripe webhook "not deployed → subscription state never syncs"** — **P1 → P2.** `check-stripe-subscription` queries Stripe **live** on every auth refresh and self-heals the DB, so entitlements reflect renewals/cancellations even without the webhook. Real issue is doc contradiction + the `config.toml` gap (folded into P0-1), not broken billing state.
- **Toast inconsistency, wide mobile tables** — **P1 → P2.** Both confirmed but purely cosmetic; desktop works, flows are safe. Don't block launch.

---

## 9. Hardening Roadmap

**P0 — before inviting more users**
- Add `verify_jwt=false` config entries + CI config-drift guard (P0-1).
- Wire the 7 orphaned money/security rehearsals into `db:rehearse:all` + a "no orphaned rehearsal" guard (P0-2).
- Rewrite `send-campaign-emails` with a time budget + resumable continuation; gate `sent` on 0-pending (P0-3).
- Slack-alert + heartbeat on the daily crons (P0-4).
- Add a `deno test` required CI job (P0-5).
- Escape all registrant-controlled fields in `send-email` templates (P0-6).

**P1 — before broader rollout**
- Fix backup truncation/coverage + restore runbook + PITR confirmation.
- PR-gated destructive e2e happy-paths; PR-gated two-tenant RLS leak probe.
- Per-failure alerting on `generate-cycle-commitment-invoices` and the email crons.
- Canonical shared module (or CI diff guard) for the Vite↔Deno pricing/name copies; reconcile `profileName`.
- Batch/scope `recalculate-invoices`; move digest/onboarding to hourly pg_cron.
- Lift the trainer/academy invoice pages into a shared hook.

**P2 — after rollout**
- Make the vitest gate deterministic (raise `testTimeout`, cap pool concurrency).
- Split god-files (`cycles.ts`, `CycleForm.tsx`); pay down the 1,039 eslint suppressions (start with the 109 exhaustive-deps).
- Bundle splitting for the 578kB main chunk / 368kB AreaChart.
- Standardize toasts on Sonner; finish mobile-table adoption.
- `send-auth-email` `redirectTo` allow-list validation; strengthen `rls-smoke-test` to assert zero anon rows; delete `import-pipeline-data` + rotate the legacy source-project anon key.
- Stale pg_cron audit + doc reconciliation (README, cloudflare-worker.js, Stripe docs).

---

## 10. Quick Wins (implementable immediately)

- **Constant-time `CRON_SECRET` compare** (`api/_lib/cron.ts`) — swap `===` for `timingSafeEqual`. NIT, trivial.
- **Add the 7 rehearsals to `db:rehearse:all`** — a few lines in `package.json`; they already pass and add seconds (closes most of P0-2).
- **Slack-on-`!allOk`** in both cron handlers — `slack-notify` exists and the service key is in scope (large chunk of P0-4).
- **`config.toml` `verify_jwt=false`** for the 5 public functions — a few stanzas (the deploy-arming half of P0-1).
- **Bump `testTimeout` to ~15000** in vitest config — de-flakes the go/no-go gate immediately.
- **`rate_limits` daily purge** — one DELETE in `daily-maintenance`.
- **Drop the hardcoded prod anon JWT/URL defaults** in `e2e/rls-health.spec.ts` — require env, fail fast.

---

**Bottom line:** The dangerous parts of this product — payments, invoicing, capacity, tenant isolation — are well-built and verified. What's missing is the machinery that keeps them well-built under change and visible under failure: CI coverage of the existing safety tests, alerting on the silent batch jobs, a safe bulk-email path, escaped emails, and a deploy that doesn't disarm the webhook. Close the six P0s (the bulk are 1–2 day fixes, several are quick wins) and this is a confident **GO**.