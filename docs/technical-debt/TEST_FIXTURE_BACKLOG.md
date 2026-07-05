# Test Fixture Backlog

Purpose: audits the current test-fixture surface and ranks the reusable fixtures worth building, so future test-writing is faster and more consistent. Documentation only — no fixtures are built here.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Related: [`TESTING_STRATEGY.md`](../TESTING_STRATEGY.md), [`TEST_COVERAGE_GAPS.md`](../TEST_COVERAGE_GAPS.md).

---

## What exists today (`src/test/fixtures/`)

| File | What it gives you | Shape |
|---|---|---|
| [`pgliteSupabase.ts`](../../src/test/fixtures/pgliteSupabase.ts) | supabase-js–shaped adapter over real PGlite (in-WASM Postgres). Runs the ACTUAL money-path lib against real SQL. Deliberately narrow: only `.eq/.neq/.gte/.in/.overlaps/.order/.range/.maybeSingle/.single/.update/.insert/.delete/.rpc` + ONE hard-coded embedded select (bookings→availability_slots→locations). `maxRows` opt-in models PostgREST's per-page cap. | adapter, not data |
| [`factory.ts`](../../src/test/fixtures/factory.ts) | Deterministic row builders `makeCycle/makeRegistration/makeSlot/makeBooking/makeInvoice` + `makeCycleWith(n)` 10k-scale harness. Stable sequential ids (`resetFactorySeq()`), no `Date.now`/random. | plain JS objects |
| [`supabaseMock.ts`](../../src/test/fixtures/supabaseMock.ts) | "Smart" JS mock that actually applies `.eq/.in` filters over rows you set via `setMockData`; RPCs are handler fns. For characterization tests that don't need real SQL. | in-memory mock |
| [`settingsSplit.golden.ts`](../../src/test/fixtures/settingsSplit.golden.ts) | Golden input for the settings-split refactor. | golden data |
| `mutationBoundaryAllowlist.json` | Allowlist consumed by [`mutationBoundary.test.ts`](../../src/test/mutationBoundary.test.ts). | config |

Deno `_shared` side: there is **no shared mock module**. Each `_shared/*.test.ts` hand-builds `Request` objects and sets `Deno.env` inline (see [`auth.test.ts`](../../supabase/functions/_shared/auth.test.ts), [`service-role-auth.test.ts`](../../supabase/functions/_shared/service-role-auth.test.ts) which locally defines `forgedServiceRoleJwt`/`b64url`/`withEnv`). Those helpers are duplicated across files.

## The core gap

**Every PGlite test hand-rolls its own schema and seed inline.** Each `*.pglite.test.ts` opens `new PGlite()`, runs its own `CREATE TABLE …` with a minimal, test-local column subset, then `INSERT`s literal rows (e.g. `cycleRoster.pglite.test.ts:51-78` creates `cycles/availability_slots/bookings/guest_players` from scratch). Consequences:
- **Schema drift** between tests (one test's `bookings` has different columns than another's), and drift from the real migrations — a column added in `supabase/migrations/` is not reflected until each test is edited.
- **Copy-paste seed** — the same "a cycle with N slots and a booking" is rebuilt in many files.
- **No reuse of `factory.ts`** by the PGlite tests (factory produces JS objects; the PGlite tests write SQL literals) — the two fixture systems don't meet.

The highest-leverage fixture work is a **shared PGlite schema + seed layer** that both loads a canonical table set (ideally derived from migrations, or a curated `schema.sql`) and exposes typed seed helpers, so `*.pglite.test.ts` files stop hand-rolling DDL.

---

## Recommended fixture categories (ranked: what's missing, why it matters)

Rank = value × how often it's re-hand-rolled today. P1 = build first.

| Rank | Fixture | Status today | Why |
|---|---|---|---|
| **P1** | **Shared PGlite schema loader** (canonical `CREATE TABLE` set for cycles/slots/bookings/invoices/guest_players/priority_claims/holds, ideally from migrations) | MISSING — every test re-declares DDL inline | Kills schema drift; unblocks all seed helpers below |
| **P1** | **Whole cycle** (cycle + N slots + capacity + split settings, seeded into PGlite) | Partially via `makeCycleWith` (JS only) + inline SQL | The unit of almost every money/booking/rebook test |
| **P1** | **Pending / paid / cancelled booking** trio on a slot | Hand-inlined per test | Webhook, hold-expiry, reconcile tests all need these three states |
| **P1** | **Mollie payment metadata** (payment id, `booking_ids`, amount, org/recipient, idempotency body) | Reasoned about only; no seed fixture | Webhook writeback + idempotency + charge-org parity all rebuild this by hand |
| **P2** | **Guest + linked-guest player** (guest_player, linked to a profile) | `makeBooking` supports the ids; no relational seed | Guest booking, merge, rebook-linked-guest, cross-tenant tests |
| **P2** | **Sent / paid invoice** (with line_items, vat_breakdown, cycle/registration linkage) | `makeInvoice` (JS) only; no PGlite seed | Invoice sync/dedup/paging tests |
| **P2** | **Priority claim** (claim row + intent + consent + reminded_at) | Hand-inlined ([`priorityClaimIntent.pglite.test.ts`](../../src/test/priorityClaimIntent.pglite.test.ts)) | Rebooking claim/consent/reminder flows |
| **P2** | **Group / captain rebook** (group + members + shared invoice booking_ids) | Hand-inlined ([`rebookGroupCapacityHolds.pglite.test.ts`](../../src/test/rebookGroupCapacityHolds.pglite.test.ts)) | Group-payment linchpin (one payment flips all booking_ids paid) |
| **P2** | **Deno `_shared` request/env/JWT helpers** (`makeReq`, `withEnv`, `forgedJwt`, `serviceRoleJwt`) as ONE module | Duplicated inline across `_shared/*.test.ts` | De-dup the auth/security edge tests; single place to keep JWT-forgery shape correct |
| **P3** | **Academy-with-trainers** (academy + trainers + `academy_trainers_public` view rows) | MISSING | Public-page / tenant-isolation / recipient-resolution tests |
| **P3** | **Trainer / academy / public slot** variants (owner_type permutations) | `makeSlot` takes overrides but no named variants | Ownership/recipient routing tests |
| **P3** | **Registration / intake** (cycle + registration + intake request + pricing table) | JS `makeRegistration`; SQL hand-inlined | Intake pricing + mint-failure (G10) tests |
| **P3** | **Hold row** (payment_pending hold + TTL) | Hand-inlined | Hold-expiry-vs-paid race (G8) |

## Adapter-extension backlog (blocks certain tests from running at all)

The PGlite adapter is intentionally minimal. These are unimplemented and will need adding when a tested function first uses them (see the docstring in [`pgliteSupabase.ts`](../../src/test/fixtures/pgliteSupabase.ts)):
- `.contains()` / `.single()` beyond the current impl, additional embedded selects beyond the one hard-coded bookings→slots→locations shape.
- True **concurrency** (two connections / transactions) — required for the G1/G3/G8 race tests; the current single-connection adapter can't model it.

## Guidance for an AI agent adding tests
1. Prefer extending an existing `*.pglite.test.ts` near your change over creating a new inline schema.
2. If you find yourself pasting a `CREATE TABLE` block, that is the signal to build the P1 shared schema loader instead — flag it, don't proliferate.
3. Use `factory.ts` builders for JS-object assertions; use PGlite seed (once the loader exists) for SQL-behavior assertions. Keep ids deterministic (`resetFactorySeq`).
4. New Deno `_shared` auth/security tests: reuse (or, first time, extract) the `withEnv`/`forgedServiceRoleJwt` helpers rather than re-copying them.
