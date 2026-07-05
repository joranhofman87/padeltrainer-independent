# Quality-Gates Backlog — missing checks

Purpose: ranked list of gates the CI pipeline does NOT have, so a mistyped/unsafe change can ship green. Each entry gives the exact missing check + a recommended implementation. Document-only — do not add heavy CI without owner sign-off.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Companion to [../QUALITY_GATES.md](../QUALITY_GATES.md) (what exists). Findings verified against `.github/workflows/*` and `scripts/` on 2026-07-02. Grounding audit: [../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md](../audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md).

Priority = blast radius if the gap lets a bug through, not effort.

---

## P0 — a money-critical path ships unchecked

### P0-1 · No type/`deno check` on any edge function `index.ts`
- **Gap:** `edge-tests` in `test.yml` runs `deno test --no-check` on `supabase/functions/_shared/` **only**. The 96 function entrypoints — including the 813-line `mollie-webhook`, `create-mollie-payment`, `auto-create-invoice` — are never type-checked or `deno check`ed anywhere in CI. A mistyped field, un-imported symbol, or removed-field access (see audit P1-8 basil `invoice.subscription`) ships with a green build and fails at runtime, on the payment path, in prod. (Audit **P2-9**, CONFIRMED, `test.yml:119`.)
- **Why it's P0 not P2:** the untyped surface is the money path. This class of bug (un-imported name → `ReferenceError`) is exactly what `typecheck:baseline` was added to catch for app code — edge fns have no equivalent.
- **Recommended implementation (start narrow, ratchet like tsc):**
  1. Add a `deno check` step to the `edge-tests` job, scoped first to the money-critical set:
     ```yaml
     - name: Edge type-check (money path)
       run: deno check supabase/functions/mollie-webhook/index.ts \
            supabase/functions/create-mollie-payment/index.ts \
            supabase/functions/auto-create-invoice/index.ts \
            supabase/functions/stripe-subscription-webhook/index.ts
     ```
  2. The `--no-check` on the *test* run stays (it's a `node_modules`-resolution issue, see QUALITY_GATES.md). `deno check` on a single file resolves remote/`_shared` imports fine.
  3. Expand the file list over time, or add a baseline ratchet (`scripts/check-edge-check-baseline.mjs`, mirroring `check-tsc-baseline.mjs`) if the full set is red today. **Verify red/green locally before wiring CI** — do not block merges on a perma-red new gate.

---

## P1 — an unsafe write can bypass the intended boundary

### P1-1 · No gate forbidding direct dangerous DB writes from UI
- **Gap:** nothing prevents a component from calling `supabase.from('bookings'|'invoices'|'availability_slots').insert/update/delete(...)` directly, bypassing the mutation-boundary libs (`src/lib/bookings.ts` `cancelBookingsAndSync`, `slotBookingWrite.ts`, `cycleWrites.ts`, invoice-sync helpers) documented in [../MUTATION_BOUNDARIES.md](../MUTATION_BOUNDARIES.md). A direct write skips invoice/split resync and capacity guards → silent money/data corruption. Lint, tsc and tests all pass.
- **Recommended implementation:** an `eslint no-restricted-syntax` (or `no-restricted-properties`) rule flagging `.from('<sensitive table>').(insert|update|delete)` outside an allowlisted set of boundary modules (`src/lib/**` write facades + `src/integrations/**`). Baseline existing violations via `eslint-suppressions.json` (shrink-only), same ratchet as the role-isolation rule already in place. Pair with a short allowlist comment in `MUTATION_BOUNDARIES.md`. Low CI cost — runs inside the existing `lint` job.

### P1-2 · No gate for unsafe invoice/booking writes (resync contract)
- **Gap:** the F2 cycle RPCs (`delete/edit/price`) only stamp `split_count`; the caller MUST resync line items afterward (`syncSplitCountForCycle` / `syncInvoicesAfterPriceChange`). Nothing enforces that a mutation which touches split state is followed by a resync — the contract lives in docs and reviewer memory only. A new caller that forgets it under-/over-bills silently.
- **Recommended implementation:** hard to lint structurally; the realistic gate is a **rehearsal**, not static analysis. Add `scripts/db/rehearse-cycle-resync-contract.{mjs,ts}` asserting that after each cycle-mutation RPC the invoice line items match the expected split — it auto-joins `db:rehearse:all` via the discovery runner. Cheaper interim: a `no-restricted-imports`-style lint that flags calling the raw cycle RPCs outside the `cycleWrites.ts` facade that owns the resync. Prefer the rehearsal — it tests behavior, not surface.

### P1-3 · Edge function integration tests run in no CI
- **Gap:** per-function `index.test.ts` files are integration tests that fetch a *deployed* function (need `VITE_SUPABASE_*`). They are intentionally excluded from `test.yml`, so nothing runs them on a schedule either. Edge-fn behavior regressions (auth gates, payment-ready, guest resolution at the `index.ts` level) are only caught by manual testing.
- **Recommended implementation:** a scheduled workflow (mirror `e2e.yml`) running the non-destructive `index.test.ts` subset against a deployed staging/prod-read env with repo secrets, weekly + `workflow_dispatch`. Keep destructive (booking/payment-creating) specs out. Low ongoing cost; not on the PR critical path.

---

## P2 — quality/consistency gaps (lower blast radius)

### P2-1 · `check:edge-config` allowlist is hand-maintained
- **Gap:** `MUST_BE_PUBLIC` in `check-edge-fn-config.mjs` is a hardcoded list. A new self-authenticating function that the author forgets to add is simply not checked — the guard is blind to it, and the fn 401s on deploy (the exact failure mode the guard exists to prevent).
- **Recommended implementation:** derive "should be public" from a marker instead of a list — e.g. a `// @verify_jwt false` header comment in `index.ts`, or a `_manifest` field — and have the script cross-check the marker against `config.toml` both ways (marked-but-not-public AND public-but-unmarked). Removes the maintenance trap.

### P2-2 · No coverage floor on the money-path libs
- **Gap:** `vitest run` gates on pass/fail but there is no coverage threshold, so deleting/skipping a money-path test doesn't fail CI. Given the PGlite harness covers real money libs, an accidental `it.skip` or removed suite silently lowers protection.
- **Recommended implementation:** enable vitest coverage with a **floor scoped to `src/lib/{bookings,invoiceSync,cycleWrites,slotBookingWrite}.ts`** (not global — a global threshold is noisy and gets disabled). Fail if coverage on those files drops below their current level. Keep it a ratchet, not a target.

### P2-3 · No dead-suppression / dead-baseline pruning gate
- **Gap:** `eslint-suppressions.json` and `tsc-app.baseline.json` are shrink-only but nothing *forces* pruning — stale entries (issues already fixed) accumulate and hide that the debt shrank. `lint:prune` / `typecheck:baseline:update` are manual.
- **Recommended implementation:** a non-fatal CI annotation (both scripts already compute "dropped below baseline") surfaced as a warning comment, plus a monthly scheduled job that fails if prunable entries exceed a threshold. Informational, not blocking.

---

## Explicitly out of scope (do not add)

- Heavy per-PR full E2E or full edge integration suites — cost/flake outweighs value; keep them scheduled.
- Global coverage thresholds — get disabled the first time they flake; scope to money-path files only.
- A gate that blocks on the known perma-red `types-drift` line-10 mismatch — that is a CLI-header artifact, not a real drift; document the `--admin` path instead (see QUALITY_GATES.md).
