# Padeltrainer — Full-App Scale-Readiness Audit

- **Date:** 2026-06-29 (validation run 2026-06-29/30)
- **Repo:** `joranhofman87/padeltrainer-independent`
- **Local path audited:** `/Users/tom/Cursor/padeltrainer`
- **Baseline:** branch `main`, HEAD `30eff5ea` (PR #245), matching `origin/main` (0 ahead / 0 behind). Working tree clean except `deno.lock`.
- **Prior audit baseline:** `56ef404b` (2026-06-28) — **34 commits** since.
- **Mode:** AUDIT-ONLY. No product code changed, no migrations applied, no edge functions deployed, no emails/payments/live side-effecting flows. Only artifact written: this report.
- **Method:** Full validation suite + 8 parallel read-only domain agents (booking, DB/RLS, edge, frontend, scale, security, observability, code-quality). Highest-severity findings adversarially re-verified against current source. Prior audit docs were cross-checked, **not** inherited.

---

## 0. Post-audit status — updated 2026-06-30

The audit pass itself changed nothing (§12). Actions taken **since** it was written:

- ✅ **P0-1 RESOLVED** — the unauthenticated `generate-proposals` endpoint is now gated in code (missing auth header → 401; invalid `auth.getUser` token → 401; admin-or-`canManageCycle` → 403; service-role bypass for cron), mirroring `finalize-proposals`. Shipped in **[#246](https://github.com/joranhofman87/padeltrainer-independent/pull/246)** (squash `bbad89a7`), **deployed to prod** (`generate-proposals` v7) and **live-smoke-verified** (no-auth → 401 "Authentication required", bad-token → 401 "Unauthorized"), guarded by a CI-run `supabase/functions/_shared/cycle-access.test.ts`.
- ⏳ **P0-2 still OPEN** — production deploy reconciliation remains an owner action. The one new edge fn from #246 was deployed, but the broader "is every recent migration/edge-fn live?" probe (release ledger §3) has not been run.
- ⏳ **All P1/P2/P3 findings below are otherwise unchanged** — none of them have been actioned yet.
- ℹ️ Unrelated feature work also merged the same day (not audit findings): cycle-roster player management ([#247](https://github.com/joranhofman87/padeltrainer-independent/pull/247)) + its slot-style UI ([#248](https://github.com/joranhofman87/padeltrainer-independent/pull/248)).

---

## 1. Executive verdict

**Is the app ready to invite more academies?** Yes — **conditional on two launch-gating fixes**: (1) close the unauthenticated `generate-proposals` endpoint, and (2) the owner runs the production deploy-reconciliation probes to prove the recent money migrations/edge-fns are live.

**Is it ready for scale (1k academies / 10k trainers / 100k+ bookings)?** The **core is genuinely strong** — server-side capacity enforcement with advisory-lock serialization, correct webhook trust models, tenant-isolated RLS with financial-tamper triggers, and hot-path indexes are all in place. The remaining scale risk is **a small set of unbounded list queries** that silently truncate at 1,000 rows (PostgREST default) and degrade for power users. These are P1 scale-blockers, not architectural breakage.

**What blocks launch (P0):**
1. ~~**`generate-proposals` is unauthenticated**~~ — ✅ **RESOLVED in [#246](https://github.com/joranhofman87/padeltrainer-independent/pull/246)** (gated + deployed + smoke-verified; see §0). Was: `verify_jwt=false`, service-role client, zero caller auth, 15+ cross-tenant writes + attacker-controlled AI-gateway spend.
2. **Production deploy state is not verified-live** for the newest money migrations (#242 STRICT pay-first, `20260702*`/`20260703*`) and edge-fn redeploys. *(Owner verification action, not a code defect — still open.)*

**Acceptable residual risk:** Everything else. No P0 in the booking core, DB/RLS, or security. The P1s are real but bounded (one stale-billing UI path, money-math duplication, unbounded queries, partial observability). The large P2/P3 backlog is maintainability/ops hardening that does not block a controlled wider launch.

**Headline improvement since the last audit (56ef404b):** `npm audit --omit=dev` dropped from **17 → 4** advisories (#214), a production release ledger (#215) and deploy-drift telemetry (#216) landed, the cycles god-file was split (#219–#226), and the observability Tier-D burn-down went from 22/93 → **40/92** functions alerting (#228/#230). Several prior P1s are now addressed in code.

---

## 2. Validation results

| Command | Result | Notes |
|---|---|---|
| `npm run typecheck:baseline` | **PASS** | Real TS gate (`scripts/check-tsc-baseline.mjs`): 107 pre-existing baselined errors, **0 new**. (Raw `npm run typecheck` shows the 107 — expected/baselined, not regressions.) |
| `npm run lint` | **PASS** | `eslint .` clean. |
| `npm test` | **PASS** | `vitest run`, exit 0. |
| `npm run build` | **PASS** | Production build, exit 0. |
| `npm run i18n:check` | **PASS** | `bun` present (1.3.14); `nl` 0 missing. (Prior audit could not run this locally — now green.) |
| `npm run check:edge-config` | **PASS** | All 25 public edge functions `verify_jwt=false` as configured. |
| `npm run test:edge` | **PASS** | Deno `_shared` tests, exit 0. |
| `npm run db:rehearse:all` | **PASS** | Migration/PGlite rehearsal suite, exit 0. |
| `npm run db:types:check` | **INCONCLUSIVE** | Requires a running local Supabase (`supabase gen types --local` failed — CLI/Docker not up). Environment limitation, **not** a drift signal. Weakens only the "types match live DB" check; CI runs this with the stack up. |
| `npm audit --omit=dev` | **4 advisories** (2 high, 2 moderate) | `dompurify` (moderate — **not reachable**, see §8), `glob` (high — build/CLI tool), `minimatch` (high — ReDoS, tooling), `brace-expansion` (moderate). Down from 17. |

> **Note on the prompt's command list:** it specified `npx tsc --noEmit`, which is a **false-green** in this repo (root `tsconfig` has `files: []`). The real gate is `npm run typecheck` / `typecheck:baseline`, used here.

---

## 3. Findings

### P0 — must fix before inviting more academies

| # | Title | Evidence | Risk | Recommended fix | Suggested test | Launch? |
|---|---|---|---|---|---|---|
| P0-1 ✅ RESOLVED (#246) | **`generate-proposals` edge function was unauthenticated** | `supabase/config.toml:118-119` (`verify_jwt=false`); `supabase/functions/generate-proposals/index.ts:333-334` (service-role client), `:352` (only validation is `if(!cycleId)`), writes at `:452` (resets `intake_requests.status='new'`), `:470/:514/:741` (deletes), `:846/:1045` (inserts proposed assignments), `:391-407` (attacker-controlled prompt → AI gateway). **No `getUser`/`requireUser`/`canManageCycle` anywhere.** Sibling `finalize-proposals` *does* gate. *(Verified directly.)* | Any anonymous internet caller with a `cycleId` (UUIDs appear in URLs/network for any logged-in user) can **wipe a cycle's pending proposal review, delete/insert proposed assignments cross-tenant, and burn AI-gateway budget**. Disruption + cost, scaling with every new academy. | Add the `finalize-proposals` gate: resolve cycle owner, `requireUser` + `canManageCycle`/`isAdminUser`, with a service-role bypass for cron. (`functions.invoke` already forwards the user JWT, so the legit path is unaffected.) | Anonymous POST with a valid `cycleId` → expect 401/403; non-manager JWT → 403; manager JWT → 200. | **Yes** |
| P0-2 | **Production deploy state not verified-live (process)** | `audit/DEPLOY_CHECKLIST.md` predates HEAD; `docs/audits/PRODUCTION_RELEASE_LEDGER_2026-06-29.md` §3. New since checklist: #242 STRICT pay-first, #244 release-holds cron, migrations `20260629120000`→`20260703160000`, edge-fn redeploys (#228/#230). CI only runs `db reset` locally — nothing proves prod sync. | A missing money migration (e.g. `book_slot_for_payment` strict-hold, `finalize_cycle_proposals`) or un-redeployed edge fn = booked-but-unbilled, dead-ended payments, or silent fallback to unbounded scans. | **Owner runs the LEDGER §3 read-only probes** (`supabase migration list`, `db push --dry-run --linked`, `functions list --linked`, the `pg_proc` name probe) and applies pending items oldest→newest before inviting academies. **Not a code change.** | Reconcile repo HEAD vs prod migration/function list; zero unexpected pending. | **Yes** |

### P1 — should fix before meaningful scale

| # | Title | Evidence | Risk | Recommended fix | Suggested test | Launch? |
|---|---|---|---|---|---|---|
| P1-1 | **`backfill-invoices` crashes on undefined vars** | `supabase/functions/backfill-invoices/index.ts:122,126` use `${supabaseUrl}` / `${supabaseServiceKey}`, **never declared** in the file. *(Verified.)* | Guaranteed `ReferenceError` the moment it finds ≥1 uninvoiced booking → creates zero invoices, ever. Admin-gated (no security exposure) but 100% broken as a recovery tool. | Declare both from `Deno.env.get(...)`, or delete if dead. | Admin run against a tenant with uninvoiced bookings → ≥1 invoice, not 500. | No (admin tool) |
| P1-2 | **DnD "move player" re-points booking with no invoice reconcile** | `src/pages/academy/AcademyCalendar.tsx:495-508` (`handleMovePlayer` = bare `bookings.update({slot_id})`); wired at `:931` (`onMovePlayer`). Sibling `handleRemovePlayer:510-532` deliberately routes through `cancelBookingsAndSync` + reconcile. *(Verified.)* | Moving a player to a slot with a different `price_per_session`/cycle leaves the invoice line at the **old price → stale billing**; not covered by `MUTATION_BOUNDARY_AUDIT.md`. | Add a `bookings.ts` facade (e.g. `moveBookingToSlotAndSync`) that re-points then calls `syncInvoicesAfterPriceChange`/`reconcileBookingInvoices`. | PGlite: move a booking €X→€Y slot, assert the invoice line re-prices. | Yes (if academy DnD across differently-priced slots is used) |
| P1-3 | **Verbatim-duplicated split-pricing money math** | `src/lib/invoiceSplitPricing.ts` ↔ `supabase/functions/_shared/invoice-split-pricing.ts` — identical `resolveInvoiceUnitPrice`/`isBookingAmountAlreadySplitShare`/`round2`/`SPLIT_SHARE_TOLERANCE`, "kept in sync" by a comment only. | A fix to one copy and not the other silently mis-bills split payments. | Single source of truth (shared module both import), or a golden drift-test (the `registration-pricing.golden.test.ts` pattern). | Property test: both copies identical across `paymentAmount × slotPrice × splitAmongPlayers`. | No (correct today; high-risk to extend) |
| P1-4 | **Unbounded list queries silently truncate at 1,000 rows** | `src/pages/TrainerBookings.tsx:113-126` (no limit/range/date — all-time); `src/pages/academy/AcademyCyclusOverview.tsx:236-256` (`while(true)` walk of ALL trainer slots all-time); `src/components/trainer/InvoiceList.tsx:104-108` (`select('*')`, no pagination). | PostgREST caps at 1,000 → **silent correctness bug** (rows vanish) plus slow wide payloads for long-tenured trainers/academies. | Server-side pagination (`.range`) like `playerBookings.ts`/`EARNINGS_LIST_LIMIT`; date-window or DB-RPC summary for the cyclus walk; column projection on invoice list. | Seed 2k bookings/1.5k invoices for one entity; assert pagination, no 1,000-cap truncation. | No (degrades for power users) |
| P1-5 | **Silent deploy-drift fallbacks (no telemetry)** | `src/lib/cycles.ts:93-94`, `src/lib/priorityClaims.ts:416`, `src/pages/TrainerEarnings.tsx:226` — `PGRST202`/`42883` → legacy unbounded path, numbers stay correct so nothing surfaces. | When a scale-migration isn't live, the app silently runs the unbounded scan it was meant to replace → invisible until OOM at scale. The release-ledger §5 names this "the standing next P1." | Emit a `notifySlackEdge`/PostHog ping when any fallback branch fires. | Unit: assert fallback branch emits a telemetry call. | No |
| P1-6 | **`forward-invoice` has no Slack alert** | `supabase/functions/forward-invoice/index.ts:346-349` (top catch → 500, 0 Slack); invoked from `auto-create-invoice:734` AND `mollie-webhook:551`. | Only named money fn still silent on failure. The double-fire itself is guarded by the atomic `forwarded_at` claim (`:97-113`), but a failure when the guard loses a race is un-alerted. | Add `notifySlackEdgeError` in the catch. | Concurrently forward a paid invoice via both paths → one forward, no silent failure. | No |
| P1-7 | **Alerting backbone has no dead-man's-switch** | `supabase/functions/slack-notify/index.ts:93-100` — if `SLACK_WEBHOOK_URL` is unset/wrong, every alert 500s with `console.error` only. | The entire Slack alerting layer can go silent with no signal — all other alerting depends on it. | External uptime monitor on a periodic heartbeat event whose **absence** pages. | Unset the var in a scratch project; confirm the heartbeat catches the silence. | No |
| P1-8 | **30 baselined `TS2304` errors blind the core money lib** | `src/lib/cycles.ts` — `export type * from './cycleTypes'` re-export ≠ local binding, so `Cycle`/`IntakeRequest`/`ScoringWeights`/… resolve as "cannot find name"; type-checking against them in cycle CRUD is effectively off. Same failure class as the prior shipped `ReferenceError`. | A real signature mismatch in cycle CRUD would not be caught at compile time. | Add `import type { Cycle, IntakeRequest, ScoringWeights, ... } from './cycleTypes'` alongside the re-export; clears 30 from the baseline. | tsc-app gate (already exists) re-checks `cycles.ts`. | No |

### P2 — maintainability / quality

| # | Title | Evidence | Recommended fix |
|---|---|---|---|
| P2-1 | `as any` casts in the group-rebook money path | `src/lib/priorityClaims.ts:312,424,427,446` (`as any[]` over `rebook_group_apply` rows + invoice booking_ids) | Type via generated `Database['public']['Functions']`. |
| P2-2 | God-files mixing domain+data+UI (>1000 LOC) | `CycleForm.tsx` (2477), `ProposalScheduleGrid.tsx` (1967), `TrainerScheduleOverview.tsx` (1771), `BulkCreateContent.tsx` (1655), `AcademyEditDialog.tsx` (1554), `AcademyCyclusOverview.tsx` (1239), `BookForPlayerDialog.tsx` (1231) | Continue the in-flight god-file-split effort (#217–#226). |
| P2-3 | Registration-confirmation email composed in multiple places | shared `_shared/registration-confirmation-email.ts` exists but `submit-guest-intake`, `create-registration-invoice`, `create-manual-player`, client `CycleForm`/`email.ts` still build their own | Route every caller through the shared composer (recurring bug class). |
| P2-4 | Legacy 3rd invoice-list renderer still live | `src/components/trainer/InvoiceList.tsx` (666 L) ← `TrainerEarnings.tsx:42`; bypasses shared `InvoiceListTable`/`InvoiceStatTiles` | Migrate onto the shared scaffold. |
| P2-5 | Duplicated role pages (create/edit invoice, player detail/list, two day-grids) | `Trainer*` vs `Academy*` ~85-95% identical; `agenda/TrainerCalendarGrid` vs `academy/AcademyDayGrid` | Owner-parameterized shared pages; converge calendars. |
| P2-6 | Lint/type debt: 990 eslint suppressions, 721 raw `any`, 105 `exhaustive-deps` (20 in money/booking) | `eslint-suppressions.json` | Generate row types; audit booking/payment effect deps (stale-closure risk). |
| P2-7 | Observability backbone gaps | no Slack rate-limit/dedup (`slack-notify`), no missed-cron heartbeat (`vercel.json`/pg_cron), no server-side error aggregator (Sentry/Logflare declined), no staging env (`config.toml` single project) | Throttle/dedup alerts; cron freshness check; durable error sink; staging Supabase project. |
| P2-8 | Backup Layer-B omits real-state tables; no restore drill; PITR unconfirmed | `audit/RUNBOOK_BACKUP_RESTORE.md:10-13,82-88` (skips campaigns, session notes, priority claims, `academy_player_metadata`) | Owner confirms PITR ON; one restore drill; extend JSON export table list. |
| P2-9 | Cycle deletion orphans slots (`ON DELETE SET NULL`) + NOT VALID constraints unpromoted | `supabase/migrations/20260630120000_phase4_C_cyclus_id_fk.sql:47-49`; `src/lib/cycleWrites.ts:200-207`; date-order checks `20260614220000:18,33` | Guard `deleteCycle` against existing slots; owner repairs orphans + `VALIDATE CONSTRAINT`. |
| P2-10 | Missing `availability_slots(academy_profile_id, start_time)` composite index | only `idx_availability_slots_academy` + `(trainer_id,start_time)` exist | Add the composite if academy calendar slows at 100k+ slots. |
| P2-11 | Edge alerting/validation tail | `reditus-referral-webhook` case-sensitive HMAC + zero alerting (`:26-29,65`); `generate-cycle-commitment-invoices` top catch no alert (~`:213`); `mollie-callback` onboarding failures no alert (`:152-223`); `bulk-update-vat` no range check (`:41,131`); `update-public-invoice-details` no throttle (`:59-99`) | Normalize HMAC + alert; add `notifySlackEdgeError`; clamp VAT 0-27; throttle the public token write. |
| P2-12 | Security hardening | guest-intake account-existence oracle (`submit-guest-intake:341-366`) + no CAPTCHA; `SafeHtml` allows `<style>` on a public page (`ui/SafeHtml.tsx:18-21`) | Return `{id}` only; add Turnstile; drop `style` from `ADD_TAGS`. |

### P3 — cleanup / nice-to-have

| # | Title | Evidence |
|---|---|---|
| P3-1 | Dead components | `src/components/trainer/QuickBookDialog.tsx` (no importers), `src/components/trainer/EditBookingDialog.tsx` (superseded by `booking/InlineEditBooking`) — delete + shrink mutation allowlist. |
| P3-2 | Legacy Lovable references | `src/pages/marketing/Brand.tsx:90` (links `github.com/lovable-dev/padeltrainer`) + stock README; 86 doc hits mostly historical. |
| P3-3 | Inconsistent page folders | 43 role pages flat in `src/pages/`, 54 nested in `src/pages/{role}/`; document or migrate. Player pages at root escape the `components/player/**` role-isolation glob (`eslint.config.js:114`). |
| P3-4 | M-17 duplicate-booking index excludes `payment_pending`/`pending_approval` | `20260612140000_m17_unique_active_bookings.sql:47,51` — capacity guard still prevents overbooking; the duplicate-row invariant is narrower. |
| P3-5 | Secondary claim-creation path not crash-idempotent | `src/lib/priorityClaims.ts:251-337` (`bulkCopySlotsToCycle`) — edge-fn `bulk-rebook-cycle` (the live path) is fine. |
| P3-6 | Missing client-side role guards | `AcademyLayout.tsx:85-89`, `ClubLayout.tsx:92-96` — RLS backstops, so UX/defense-in-depth only. |
| P3-7 | Invoice `public_token` no expiry/single-use; wildcard CORS on ~62 fns (not CSRF-exploitable); `resend-webhook` svix-id null check; finalize-proposals implicit service-key propagation | see security/edge sections. |
| P3-8 | In-flight cycle-extension partial-write edge | `src/lib/cycleExtension.ts:235` bumps `end_date` before inserting slots; insert slots first (idempotent dedup heals re-runs). |

---

## 4. Confirmed-good (verified this pass, not inherited)

- **Capacity is enforced server-side for every authenticated path** with race protection: `enforce_booking_slot_tier` BEFORE INSERT/UPDATE trigger (`20260702120000`/`20260702140000`/`20260703140000`) preceded by `pg_advisory_xact_lock(hashtextextended(slot_id,0))`, with the same lock key shared across the trigger, `book_slot_for_payment`, `respond_to_priority_claim`, and `swap_member_booking`. The prior staff/guest bypass is closed.
- **STRICT Mollie pay-first holds (#242) cannot wrongly block capacity:** `status='payment_pending'` with `hold_expires_at` TTL; all capacity counts treat a hold as occupying only while unexpired (self-healing), and a 5-min `release_expired_rebook_holds()` cron cancels stragglers (guarded on `status='payment_pending'`).
- **Webhook trust models are correct:** `mollie-webhook` ignores the POST body amount/status, re-fetches the authoritative payment via the connected-account token, verifies `status='paid'` AND amount before flipping; `stripe-subscription-webhook` verifies the signature; both fail-closed. Mollie 500-on-transient / 200-on-terminal retry contract is correct.
- **Idempotency / no double-charge:** atomic paid-claim shared by webhook + verify path, `claim_stripe_event`, `next_invoice_sequence` atomic numbering + 23505 retry, unique partial indexes on live invoices/bookings. The historical `forward-invoice` double-fire is guarded by the `forwarded_at` atomic claim.
- **RLS tenant isolation holds in final migration state:** every early `USING(true)` policy on profiles/slots/mollie was explicitly dropped; anon reads go through postgres-owned `_public`/`_safe` views; SECURITY DEFINER readers self-authorize (`get_players_overview` raises `42501`); money RPCs (`book_slot_for_payment`, `finalize_cycle_proposals`) are service-role-only; BEFORE-UPDATE triggers block players from self-marking invoices/bookings paid.
- **Hot-path indexes exist:** `bookings(slot_id)`, `(slot_id,status)`, `(player_id)`, `(guest_player_id)`; `availability_slots(cyclus_id)`, `(trainer_id,start_time)`; `invoices(trainer_id)`, `(academy_profile_id)`, `(academy,status,created)`, **`booking_ids` GIN**.
- **Secrets clean:** `.env` gitignored; only the publishable/anon key in history; no service-role/Mollie/Resend/Stripe secret ever committed.
- **DOMPurify advisory not reachable:** installed `3.4.8`; `SafeHtml` uses inline-config `sanitize()` (no `setConfig`/`RETURN_TRUSTED_TYPE`), guarded by `safeHtml.test.tsx`. The 4 `dangerouslySetInnerHTML` hits are all developer-controlled (chart theme, static JSON-LD).
- **Well-bounded scale paths already done:** `TrainerEarnings` (server-side summary RPC + 500 cap + fallback), `playersOverview` (server pagination RPC), `playerBookings` (`.range`), `AcademyDashboard` (every sub-query `.limit()`+`Promise.all`), calendar/agenda/reports (all date-range bounded), 164 `lazy()` route splits + deliberate `manualChunks`.
- **Shared-component governance is real:** `CycleDetailView`, `InvoiceSettingsCardBase`, invoice-list scaffold, `PlayerDetailsCard`, `ListPageShell`/`DataTableCard` genuinely reused via thin role wrappers; role-isolation `no-restricted-imports` baseline is **0**; mutation-boundary allowlist holds at 36 writes/26 files, all classified.
- **In-flight cycle-extension feature (#243) is correct & invoice-safe:** DST-safe, instant-dedup idempotent, resets rebook markers so generated weeks are bookable, TOCTOU-safe trim.
- **`DOMAIN_MODEL.md` is current** (references the live `phase4_C` FK migration; canonical write fns exist). **0 TODO/FIXME/HACK** in source.

---

## 5. Scale-readiness assessment

| Target | Verdict | Basis |
|---|---|---|
| **1,000 academies** | Ready after P0-2 deploy-verify | Tenant isolation is enforced and indexed; per-academy reads are scoped. Watch `AcademyCyclusOverview` full-walk (P1-4) for academies with years of cycles. |
| **10,000 trainers** | Ready, with P1-4 caveats | Trainer earnings/dashboard already server-side. `TrainerBookings` unbounded all-time fetch (P1-4) and the global `Trainers.tsx` public list (no pagination) need bounding for power users / the public directory. |
| **100,000+ bookings** | Core ready; fix unbounded queries | Capacity + indexes scale. The three unbounded list queries (P1-4) hit the silent 1,000-row PostgREST cap — a correctness bug at this volume, not just slowness. No N+1 patterns found (all multi-entity reads batch via `.in(...)`). |

---

## 6. Architecture assessment

- **Data-model clarity:** Good and documented. Slots/cycles/registrations are split; `cycles` is the unifying table; `invoices.booking_ids uuid[]` (no FK, GIN-indexed) is intentional. The one soft spot is `availability_slots.cyclus_id` being `ON DELETE SET NULL` + `NOT VALID` (P2-9) — orphan risk on cycle delete.
- **Role separation:** Strong. Role-isolation ESLint with a genuine 0 baseline; player/trainer/academy/club/admin boundaries enforced by RLS + per-function authz. Gaps are defense-in-depth only (P3-6).
- **Shared components:** Materially better than the prior audit implies — `InvoiceSettingsCardBase` convergence is done (doc is stale). Remaining duplication is the create/edit invoice pages and player detail/list (P2-5).
- **Mutation boundary:** Guarded by a shrink-only allowlist test (36/26). The one uncovered hole is `handleMovePlayer` (P1-2) — a real stale-billing path the audit doc misses.
- **Server-side heavy operations:** The money path is correctly server-heavy (RPCs/triggers/webhooks). The remaining client-side aggregation (dashboards/cyclus grouping) is mostly date/trainer-bounded; push to SQL as volume grows.
- **Testability:** Strong — PGlite money-path tests, golden pricing tests, `db:rehearse:all`, edge tests, real tsc-app baseline gate. Main blind spot: 30 `TS2304` errors in `cycles.ts` (P1-8) and no authenticated staging E2E.

---

## 7. Component-reuse assessment

- **Working well (don't touch):** `CycleDetailView` + role wrappers, `InvoiceSettingsCardBase`, invoice-list scaffold (`InvoiceListTable`/`InvoiceStatTiles`/`ListPagination`), `PlayerDetailsCard`, `ListPageShell`/`DataTableCard`, booking facades, `TrainerCalendarGrid` (trainer+club), `lib/bookings|slots|invoices` mutation facades.
- **Duplicated / next to standardize (priority):** (1) a `moveBookingToSlot` facade — fixes P1-2, correctness not tidiness; (2) create/edit invoice pages → one owner-parameterized page (~600 LOC removable); (3) `PlayerDetailShell`; (4) converge `AcademyDayGrid` onto the shared agenda grid; (5) retire legacy `trainer/InvoiceList`; delete dead `QuickBookDialog`/`EditBookingDialog`.
- **AI-drift hotspots:** `handleMovePlayer` vs `handleRemovePlayer` (adjacent, only one reconciles); three invoice-list renderers; ×2 create/edit invoice pages; ×2 player detail/list; two day-grid calendars; the verbatim split-pricing duplication (P1-3); dead components as copy-paste bait.

---

## 8. Security / RLS assessment

**No P0/P1 exploitable cross-tenant or unauthenticated data/money vulnerability** — except the **`generate-proposals` open endpoint (P0-1)**, which is mutation+cost, not data-theft. Otherwise:
- RLS isolation verified in final state (§4); financial-tamper triggers; anon-via-views; service-role money RPCs.
- Tokens unguessable: priority-claim/rebook-group tokens are 192-bit `gen_random_bytes(24)`, status-gated single-use, window-expiring. Invoice `public_token` is 122-bit UUID but reusable/non-expiring (P3-7).
- Webhook trust models correct; secrets clean; DOMPurify advisory not reachable.
- P2/P3 hardening: guest-intake oracle + no CAPTCHA, `SafeHtml` `<style>`, wildcard CORS (not CSRF-exploitable — Bearer tokens, no `Allow-Credentials`), missing client-side role guards.
- **Open thread for follow-up:** `email_campaign_recipients` insert-time RLS was not traced (send path is owner-scoped and safe).

---

## 9. Observability / backup / deploy assessment

- **Alerting:** 40/92 functions wired to Slack (up from 22/93); all money/webhook/invoice-mint paths alert; `invoice-health-check` provides genuine Mollie↔invoice reconciliation (3 anomaly checks, daily). Gaps: `forward-invoice` (P1-6), reditus (P2-11), and the structural backbone — no dead-man's-switch (P1-7), no rate-limit/dedup, no missed-cron heartbeat, no durable server-side aggregator (P2-7).
- **Backup/restore:** Runbook is thorough and honest about gaps; PITR unconfirmed, Layer-B export incomplete, no restore drill (P2-8).
- **Deploy:** Edge fns + migrations deploy **manually** (CI only validates). A release ledger (#215) and deploy-drift telemetry (#216) exist, but the live state is not verified for the newest money changes (**P0-2**). No staging environment.

---

## 10. Top 10 recommended next changes

1. ~~**P0-1** — Add auth gate to `generate-proposals`~~ — ✅ done (#246).
2. **P0-2** — Owner runs the release-ledger §3 probes; apply pending money migrations/edge-fns; confirm live.
3. **P1-2** — `moveBookingToSlotAndSync` facade so academy DnD reconciles invoices.
4. **P1-3** — Collapse split-pricing math to one source (or golden drift-test).
5. **P1-4** — Bound `TrainerBookings`, `AcademyCyclusOverview`, trainer `InvoiceList` (pagination/date-window/RPC).
6. **P1-8** — One-line `import type` fix in `cycles.ts` to un-blind type-checking.
7. **P1-1** — Fix `backfill-invoices` undefined vars (or delete).
8. **P1-5 / P1-6 / P1-7** — Fallback telemetry, `forward-invoice` alert, Slack dead-man's-switch heartbeat.
9. **P2-7 / P2-8** — Cron freshness check, alert rate-limit/dedup, confirm PITR + one restore drill, stand up staging.
10. **P2-12 / P3-1 / P3-2** — Security hardening (Turnstile, drop `<style>`, intake response), delete dead components, clear public Lovable refs.

---

## 11. Suggested phased remediation plan

- **Phase A — Launch blockers:** ~~P0-1 (`generate-proposals` auth — ✅ done #246)~~, P0-2 (deploy reconciliation — still open). *Gate the wider academy invite on P0-2.*
- **Phase B — Scale blockers:** P1-2 (move-player billing), P1-3 (split-pricing dup), P1-4 (unbounded queries), P1-5 (fallback telemetry), P1-1 (backfill), P2-10 (academy composite index).
- **Phase C — Component / code-quality foundation:** P1-8 (cycles.ts types), P2-1/2/3/4/5/6 (god-file splits, shared invoice/player pages, registration-email composer, `any`/deps burn-down), P3-1 (dead code).
- **Phase D — Observability / ops:** P1-6/7, P2-7/8/11 (forward-invoice alert, dead-man's-switch, rate-limit, cron heartbeat, aggregator, backup drill, staging, edge alerting tail).
- **Phase E — Long-term cleanup:** P2-9 (cycle-FK guard + VALIDATE), P2-12 / P3 (security hardening, role guards, token expiry, Lovable refs, folder structure, M-17 index, cycle-extension write order).

---

## 12. Reviewer self-check

- ✅ No product code changed (only this report written).
- ✅ No migrations applied.
- ✅ No edge functions deployed.
- ✅ No emails sent, no payments triggered, no live booking/registration/invoice/rebooking/campaign/webhook flows invoked. Validation used local/ephemeral commands only.
- ✅ Every P0/P1 verified against current source (P0-1, P1-1, P1-2 re-read directly; index claims reconciled across the scale + DB agents).
- ✅ Old audit docs were cross-checked, not trusted: the prior P1 dependency-audit (17→4), release-ledger, deploy-drift telemetry, and observability burn-down were re-verified against HEAD; the `InvoiceSettingsCardBase` "still split" and observability "Tier-D open" claims were found **stale** and corrected.
- ⚠️ `db:types:check` could not run locally (needs running Supabase) — the only weakened check; CI covers it.
