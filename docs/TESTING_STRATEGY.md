# Testing Strategy — required tests by change type

Purpose: tells an AI agent or human exactly which tests MUST accompany a change, which runner to use, and how to run it — so changes stay safe and CI-green.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

---

## The test runners (what each one is for)

| Runner | Command | Scope | Environment |
|---|---|---|---|
| **vitest unit** | `npm test` (`vitest run`) | Pure TS/TSX in `src/**/*.test.{ts,tsx}` — lib logic, React components (jsdom + RTL) | mocked Supabase; no network ([`vitest.config.ts`](../vitest.config.ts) sets dummy env) |
| **PGlite integration** | `npm test` (same run; files `src/**/*.pglite.test.ts`) | The REAL money-path lib run against real Postgres-in-WASM via the [`pgliteSupabase`](../src/test/fixtures/pgliteSupabase.ts) adapter | in-process Postgres; `// @vitest-environment node` |
| **deno _shared** | `npm run test:edge` (`deno test --allow-env --allow-net supabase/functions/_shared/`) | Edge-function SHARED helpers only (`supabase/functions/_shared/*.test.ts`) | Deno; CI runs it `--no-check` |
| **db:rehearse** | `npm run db:rehearse:all` (individual: `db:rehearse:*`) | SQL migrations / RPC / RLS invariants replayed against a fresh DB (`scripts/db/*`) | needs local Supabase / PGlite per script |
| **migrations validate** | `npm run db:reset` (`supabase db reset`) | Every migration in `supabase/migrations/` applies cleanly + generated-types drift | local Supabase |
| **playwright e2e** | `npm run test:e2e` (`playwright test`) | Full browser journeys in `e2e/*.spec.ts` + `tests/*.spec.ts` | `npm run dev` server, baseURL `http://localhost:8080` |

> Root `tsc --noEmit` checks NOTHING (`files:[]`). The real type gate is `npm run typecheck:baseline` (`tsc -p tsconfig.app.json` ratcheted vs `scripts/tsc-app.baseline.json`). Edge-function `index.ts` files are NOT type-checked or deno-checked in CI — only `_shared/` is deno-tested, `--no-check`. Per-function `index.test.ts` (7 exist) are manual integration tests, NOT in CI.

## CI gates (from `.github/workflows/`)

- **test.yml** — `lint` (ratcheted eslint via `eslint-suppressions.json`, shrink-only) + `check:edge-config` (edge verify_jwt drift) | `typecheck:baseline` + `vite build` | `test:unit`, `test:db` ×2 shards (`vitest --shard=i/2`, exact partition, `fileParallelism: false` per runner), `db:rehearse:all` ×2 shards (round-robin, exactly-once union pinned by `src/test/rehearsalSharding.test.ts`) and `i18n:check` (bun, en+nl parity) — aggregated by the required `test` gate | `deno test --no-check` on `_shared/`. Locally `npm test` + `db:rehearse:all` still run everything unsharded.
- **migrations.yml** — `supabase db reset` + generated-types drift.
- **e2e.yml** — playwright: navigation/i18n/error-handling/accessibility/rls-health/invoice-health/performance, then roles/payments/booking. **seo-smoke.yml**, **sitemap.yml**.

A change is not "done" until the gates that cover its change type below are green.

---

## Required tests BY CHANGE TYPE

For each: **runner → what MUST be covered → how to run.** Ground new tests in the cited existing examples.

### 1. Payment (charge / webhook / Mollie / split)
Money is the highest-risk surface. See [`payments/PAYMENT_INVARIANTS.md`](payments/PAYMENT_INVARIANTS.md) — every payment change must preserve those invariants.
- **PGlite integration (required):** the actual writeback / charge lib against real SQL.
  - MUST cover: amount-match incl. multi-booking sum tolerance ([`paymentAmountInvariant.test.ts`](../src/test/paymentAmountInvariant.test.ts)); atomic paid-claim transitions exactly the right rows ([`mollieWebhookWriteback.pglite.test.ts`](../src/test/mollieWebhookWriteback.pglite.test.ts)); M-17 webhook survivor / collision ([`mollieWebhookM17Survivor.pglite.test.ts`](../src/test/mollieWebhookM17Survivor.pglite.test.ts)); charge-org == confirm-org parity ([`chargeConfirmParity.pglite.test.ts`](../src/test/chargeConfirmParity.pglite.test.ts)); split divisor frozen to court capacity ([`splitDivisor.contract.test.ts`](../src/lib/splitDivisor.contract.test.ts)); reconcile RPC ([`reconcilePayments.pglite.test.ts`](../src/test/reconcilePayments.pglite.test.ts)).
- **deno _shared (required for edge-charge helpers):** idempotency-key fingerprint ([`mollie-idempotency.test.ts`](../supabase/functions/_shared/mollie-idempotency.test.ts)), booking pricing / split ([`booking-pricing.test.ts`](../supabase/functions/_shared/booking-pricing.test.ts)), payment-ready gate ([`mollie-payment-ready.test.ts`](../supabase/functions/_shared/mollie-payment-ready.test.ts)), payment audit ([`payment-audit.test.ts`](../supabase/functions/_shared/payment-audit.test.ts)).
- Run: `npm test` + `npm run test:edge`.

### 2. Booking (single slot / cycle insert / capacity)
- **PGlite integration (required):** capacity holds and per-slot atomicity — [`guestSlotBooking.pglite.test.ts`](../src/test/guestSlotBooking.pglite.test.ts), [`guestCyclusBooking.pglite.test.ts`](../src/test/guestCyclusBooking.pglite.test.ts), [`guestBookingToken.pglite.test.ts`](../src/test/guestBookingToken.pglite.test.ts), booking_ids stamping [`bookLessonPaymentBookingIds.test.ts`](../src/test/bookLessonPaymentBookingIds.test.ts).
- **vitest unit (required):** slot-delete guard vs booking loss ([`slotDeleteGuard.test.ts`](../src/test/slotDeleteGuard.test.ts) + golden), financial guard ([`bookingFinancialGuard.test.ts`](../src/test/bookingFinancialGuard.test.ts)), the `bookings.ts` facade ([`src/lib/bookings.test.ts`](../src/lib/bookings.test.ts)).
- **db:rehearse:** `rehearse-book-slot`, `rehearse-capacity-locks`, `rehearse-strict-hold-capacity`.
- **Known gap:** logged-in cycle insert lacks a capacity lock (PAYMENT_TEST_GAPS G6) — a concurrent overbook test is owed if you touch `insertBookings`.

### 3. Rebooking (priority claim / group captain)
- **PGlite integration (required):** claim intent ([`priorityClaimIntent.pglite.test.ts`](../src/test/priorityClaimIntent.pglite.test.ts)), group capacity holds ([`rebookGroupCapacityHolds.pglite.test.ts`](../src/test/rebookGroupCapacityHolds.pglite.test.ts)), single-rebook invoice dedup ([`rebookSingleInvoiceDedup.pglite.test.ts`](../src/test/rebookSingleInvoiceDedup.pglite.test.ts)), public gather cross-tenant scope ([`rebookPublicGatherScope.pglite.test.ts`](../src/test/rebookPublicGatherScope.pglite.test.ts)), strict accept-payable ([`strictAcceptPayable.test.ts`](../src/test/strictAcceptPayable.test.ts)).
- **vitest unit:** [`src/lib/rebookManage.test.ts`](../src/lib/rebookManage.test.ts), [`src/lib/bulkCycleBookings.test.ts`](../src/lib/bulkCycleBookings.test.ts).
- **e2e:** `tests/rebooking-enforcement.spec.ts`.
- **db:rehearse:** `rehearse-rebook-group-claims`, `rehearse-strict-accept-release`.

### 4. Registration / intake (public + guest)
- **PGlite integration:** registration write path — [`db:rehearse:registration-write`](../scripts/db/rehearse-registration-write.ts) plus [`registrations.test.ts`](../src/test/registrations.test.ts).
- **vitest unit (required):** intake pricing must match BOTH build sites (client + server composer) — [`registrationPricing.test.ts`](../src/test/registrationPricing.test.ts); [`cycleCommitmentInvoicing.test.ts`](../src/test/cycleCommitmentInvoicing.test.ts).
- **deno _shared:** golden pricing parity ([`registration-pricing.golden.test.ts`](../supabase/functions/_shared/registration-pricing.golden.test.ts)).
- **e2e:** `e2e/registration.spec.ts`.

### 5. Invoice (create / sync / dedup / paging)
- **PGlite integration (required):** dedup RPC ([`createInvoiceDeduped.pglite.test.ts`](../src/test/createInvoiceDeduped.pglite.test.ts)); sync + PAGING (must assemble > 1 PostgREST page via the `maxRows` opt-in) — [`invoiceSync.pglite.test.ts`](../src/lib/invoiceSync.pglite.test.ts), [`invoiceSyncPaging.pglite.test.ts`](../src/lib/invoiceSyncPaging.pglite.test.ts); cycle-edit sync + totals ([`cycleEditInvoiceSync.pglite.test.ts`](../src/test/cycleEditInvoiceSync.pglite.test.ts), [`cycleEditInvoiceTotals.pglite.test.ts`](../src/test/cycleEditInvoiceTotals.pglite.test.ts)).
- **vitest unit:** calc/VAT ([`src/lib/invoiceCalc.test.ts`](../src/lib/invoiceCalc.test.ts)), customer insert, [`invoices.test.ts`](../src/test/invoices.test.ts).
- **db:rehearse:** `db:rehearse:invoices-delivery`, `db:rehearse:invoice-status`, `db:rehearse:invoices-partition`, `rehearse-invoice-recipient`, `rehearse-invoice-pagination`.

### 6. Role / RLS / security
- **deno _shared (required):** auth guards — [`auth.test.ts`](../supabase/functions/_shared/auth.test.ts), [`service-role-auth.test.ts`](../supabase/functions/_shared/service-role-auth.test.ts) (the fixed P0 forged-JWT regression), [`cycle-access.test.ts`](../supabase/functions/_shared/cycle-access.test.ts).
- **vitest unit:** service-role/auth boundary ([`serviceRoleAuth.test.ts`](../src/test/serviceRoleAuth.test.ts)), mutation-boundary allowlist ([`mutationBoundary.test.ts`](../src/test/mutationBoundary.test.ts)), access checks (`invoiceAccess`, `manualPlayerAccess`, `clubTrainerAccess`).
- **db:rehearse (required for RLS):** `rehearse-academy-tenant-isolation`, plus RLS migration tests ([`migrationsBookingsRls.test.ts`](../src/test/migrationsBookingsRls.test.ts), [`migrationsPlayerSecurityHardening.test.ts`](../src/test/migrationsPlayerSecurityHardening.test.ts)).
- **e2e:** `e2e/rls-health.spec.ts`, `e2e/roles.spec.ts`. Every new edge fn MUST self-authenticate via `_shared/auth.ts` (verify_jwt=false is by design; `check:edge-config` enforces the drift).

### 7. UI component
- **vitest unit (RTL, required):** render + behavior in jsdom. Examples: [`cycleDetailView.test.tsx`](../src/test/cycleDetailView.test.tsx), [`slotEditForm.test.tsx`](../src/test/slotEditForm.test.tsx), [`slotGeneratorWizard.test.tsx`](../src/test/slotGeneratorWizard.test.tsx). Use `renderWithI18n` / `renderWithCycles` helpers.
- Shared-component changes: assert reuse via the scaffold/golden tests ([`invoiceListSharedScaffold.test.ts`](../src/test/invoiceListSharedScaffold.test.ts), [`settingsSplit.golden.test.ts`](../src/test/settingsSplit.golden.test.ts)). Any new UI string needs en+nl keys (`i18n:check` gate). Follow [`UI_COMPONENT_STANDARDS.md`](UI_COMPONENT_STANDARDS.md) + role-isolation ESLint ([`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md)).

### 8. Public / SEO page
- **e2e (required):** `e2e/seo-smoke.spec.ts` + **seo-smoke.yml** / **sitemap.yml** CI. Public pages read via postgres-owned `_public`/`_safe` views — a live anon probe (publishable key) or [`invoiceHealthChecks.test.ts`](../src/test/invoiceHealthChecks.test.ts) style check confirms anon SELECT still works.

### 9. Edge function
- **deno _shared (required):** if the change touches a `_shared/` helper it MUST have/keep a `_shared/*.test.ts` — that is the ONLY edge code in CI. Function `index.ts` is NOT type/deno-checked in CI; keep logic in testable `_shared/` helpers.
- **check:edge-config (required):** new/changed function must satisfy the verify_jwt config gate (`npm run check:edge-config`).
- Remember: edge functions do NOT auto-deploy — owner applies manually; tests are your only pre-deploy safety net.

### 10. Migration
- **migrations validate (required):** `npm run db:reset` (`supabase db reset`) — the real gate; must apply cleanly + regenerate types with no drift.
- **db:rehearse (required):** add/extend a `scripts/db/rehearse-*` that replays the new RPC/trigger/index and asserts the invariant (e.g. [`rehearse-recalc-split.mjs`](../scripts/db/rehearse-recalc-split.mjs), `rehearse-phase45-integrity`). Wire it into `db:rehearse:all` if it should gate.
- Migrations do NOT auto-deploy — the owner applies them by hand; the rehearsal is the proof-of-safety.

---

## How to run everything locally
```bash
npm run lint && npm run check:edge-config      # gate 1
npm run typecheck:baseline && npm run build     # gate 2
npm test                                        # vitest + PGlite
npm run db:rehearse:all                         # SQL invariants
npm run i18n:check                              # en+nl parity
npm run test:edge                               # deno _shared
npm run db:reset                                # migrations (needs local supabase)
npm run test:e2e                                # playwright (needs dev server)
```
Match the runner to your change type above; you do not need all gates for every change, but you MUST run the ones your change type lists as required.
