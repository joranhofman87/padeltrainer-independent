# Quality Gates

Purpose: the single canonical map of every automated check — what each `package.json` script does, what CI actually protects, and where the real gate lives (some obvious-looking gates check nothing).
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

Before you change code, know which gate will catch a mistake — and which gates give false confidence. Related: [LINTING.md](./LINTING.md) (ratchet mechanics), [TESTING_STRATEGY.md](./TESTING_STRATEGY.md) (test layers), [technical-debt/QUALITY_GATES_BACKLOG.md](./technical-debt/QUALITY_GATES_BACKLOG.md) (missing gates).

## TL;DR — the traps

- **`npm run typecheck` / bare `tsc` is NOT the gate.** Root `tsconfig.json` has `files: []` and type-checks nothing. The real type gate is `typecheck:baseline` (`tsc -p tsconfig.app.json`, ratcheted). A value-call to an un-imported name is a runtime `ReferenceError` that only this gate catches — lint, vitest and `vite build` all miss it.
- **Edge functions (`supabase/functions/*/index.ts`) are NOT type-checked or `deno check`ed in CI.** `edge-tests` runs `deno test --no-check` on `_shared/` only. The 813-line `mollie-webhook` and 95 other function entrypoints ship with a green build even if a symbol is mistyped or un-imported. See backlog P0-1.
- **Migrations + edge functions do NOT auto-deploy.** CI only *validates*. The owner applies migrations and redeploys functions manually. Frontend auto-deploys via Vercel on merge to `main`.
- **`git commit --admin` past a red build is only safe for the known perma-red gates** (`types-drift` line-10 CLI mismatch). Never `--admin` past a genuinely new `typecheck:baseline` / `db-reset` / `vitest` failure.

## Gate table

| Gate | Script | What it catches | In CI? | Notes |
|---|---|---|---|---|
| Lint (ratcheted) | `npm run lint` (`eslint .`) | New eslint violations of any rule (role-isolation imports, a11y, hooks, unused). | ✅ `test.yml` → `lint` | Gated by `eslint-suppressions.json`, **shrink-only**: a NEW violation fails; fixing a suppressed one requires `npm run lint:prune` + commit or the gate fails on stale suppressions. See [LINTING.md](./LINTING.md). |
| Edge config drift | `npm run check:edge-config` (`scripts/check-edge-fn-config.mjs`) | A public/self-authenticating edge fn missing `verify_jwt = false` in `config.toml` → gateway 401s it on deploy (e.g. mollie/stripe webhooks, public images). | ✅ `test.yml` → `lint` | Hardcoded allowlist `MUST_BE_PUBLIC`. **Add every new no-JWT function to it** or the guard is blind to it. |
| Edge import pins | `npm run check:edge-pins` (+ `:selftest`) (`scripts/check-edge-import-pins.mjs`) | An external import in the edge-function bundle graph that names a version **range** (`@2`, `@2.0`, `^2.57.2`, `latest`, or no version), a **computed** dynamic specifier (`import(`…${v}`)`), or a file that does not parse. A floating specifier makes deployability depend on what a CDN resolves that hour — it is what broke 15 of 18 function deploys on 2026-08-06. | ✅ `test.yml` → `lint` | Scans **entrypoints AND `_shared/`** — a shared module is bundled into every importer, which is how 5 of the 15 failures happened. Extraction uses the **TypeScript parser**, not regexes: three review rounds each found a fresh hole in the regex lexer (comments, strings, regex literals, `.import()` methods), because classifying those *is* parsing. Fails closed on an unparseable file. Its sibling `check:edge-types` now also fails closed on any non-type `deno` error (an unresolvable specifier used to yield ZERO errors, silently un-checking 14 functions while the ratchet read it as an improvement). **`deno.lock` cannot substitute:** `supabase functions deploy` bundles server-side and never reads it, so CI resolved a pinned 2.108.2 while the deploy resolved 2.112.2. See [EDGE_FUNCTION_DEPLOY_SAFETY.md §4e](./deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md). |
| Type-check (real) | `npm run typecheck:baseline` (`scripts/check-tsc-baseline.mjs`) | NEW `tsc -p tsconfig.app.json` errors vs `scripts/tsc-app.baseline.json`. Cross-module name resolution → the un-imported-name `ReferenceError` class. | ✅ `test.yml` → `typecheck` | Project is perma-red with known pre-existing errors; ratchets on new only (signature = `file\|code\|message`, line/col stripped). Regenerate: `npm run typecheck:baseline:update`. **`npm run typecheck` and root `tsc` check nothing.** |
| Production build | `npm run build` (`vite build`) | Import/resolution/build-time failures; broken bundle. | ✅ `test.yml` → `typecheck` | Does NOT type-check app source (SWC strips types). Complements, does not replace, `typecheck:baseline`. |
| Unit tests | `npm test` (`vitest run`) | App-lib logic, money-path libs (via the PGlite/Supabase harness), component behavior. | ✅ `test.yml` → `unit-tests` + `db-tests` ×2 shards, aggregated by `test` | Full `vitest run` is a required gate (locally `npm test` still runs everything unsharded). In CI the `db` project splits across two runners via `vitest --shard=i/2` — an exact partition of the hash-sorted file list; `fileParallelism: false` still holds *within* each runner. Includes the real money-path libs against real Postgres (PGlite). Does NOT cover Deno edge fn `index.ts`. |
| Data-integrity rehearsals | `npm run db:rehearse:all` (`scripts/db/run-all-rehearsals.mjs`) | RLS tenant isolation, RPC contracts, and list-partition completeness (a list RPC must never HIDE a record — e.g. paid/unpaid invoice tabs are a complete partition across every status). Split recalc, capacity locks, atomic invoice numbering, booking-tier enforcement. | ✅ `test.yml` → `db-rehearsals` ×2 shards, aggregated by `test` | **Auto-discovers every `scripts/db/rehearse-*.{mjs,ts}`** (46 today) — adding a rehearsal auto-includes it; none can be silently dropped. CI shards the discovered inventory round-robin (`--shard=i/2`, `scripts/db/rehearsal-shards.mjs`); the exactly-once union is pinned by `src/test/rehearsalSharding.test.ts`. Individual `db:rehearse:*` scripts exist for local iteration. |
| i18n parity | `bun scripts/check-i18n-parity.ts` (`npm run i18n:check`) | en/nl key drift — a translation key present in one locale but missing in the other. | ✅ `test.yml` → `i18n`, aggregated by `test` | Runs under **Bun**, not Node. |
| Edge unit tests | `deno test --no-check … supabase/functions/_shared/` (`npm run test:edge`) | Shared edge logic: auth gates, Mollie payment-ready, pricing math, guest-name resolution. | ✅ `test.yml` → `edge-tests` | **`--no-check`**: no `node_modules`, so Deno can't resolve `@types/node` (transitive via supabase-js) — type-check phase would kill the job. Value = RUNNING the tests, not type-checking. **Only `_shared/` runs; function `index.ts` files run in NO CI gate.** Per-function `index.test.ts` are integration tests (need a *deployed* fn + secrets) — intentionally excluded. |
| Migration validity | `supabase db reset --yes` (`npm run db:reset`) | A migration that fails to apply from scratch; broken SQL; ordering issues. | ✅ `migrations.yml` → `db-reset` | Only runs on PRs touching `supabase/migrations/**`, `types.ts`, or the drift script. This is the REAL migration gate. CLI pinned to `2.107.0`. |
| Generated-types drift | `npx tsx scripts/check-types-drift.ts` (`npm run db:types:check`) | `src/integrations/supabase/types.ts` out of sync with the schema after a migration. | ✅ `migrations.yml` → `types-drift` | **Known perma-red on a line-10 CLI header mismatch** → merges go `--admin`. Uploads `types.generated.ts` artifact on failure so you can diff/regenerate. |
| E2E (non-auth + role/pay/booking smoke) | `npx playwright test …` (`npm run test:e2e`) | Render + routing + i18n + a11y + RLS-health + invoice-health + perf; role/payment/booking UI smoke (non-destructive, route-mocked). | ⏰ `e2e.yml` **weekly** (Sun 05:00 UTC) + manual | NOT on every PR. No account/booking creation. |
| SEO smoke | `npx playwright test e2e/seo-smoke.spec.ts` | Prod render-page/indexing (Googlebot GETs); 404 pass-through. | ⏰ `seo-smoke.yml` weekly (Mon) + manual | Read-only against **prod**. Run after deploying the Cloudflare worker. |
| Sitemap smoke | curl checks (inline in workflow) | Every sitemap variant + `llms-full-txt` returns non-empty XML with ≥1 `<url>`. | ⏰ `sitemap.yml` weekly (Mon) + manual | Read-only against the prod sitemap edge fn. |

## What each CI workflow runs

- **`test.yml`** (every push/PR to main; a newer commit on the same PR branch auto-cancels the obsolete run, other branches and main pushes are never touched): parallel jobs —
  - `lint`: `npm run lint` + `check:edge-config` + `check:legacy-key`(+selftest) + `check:edge-pins`(+selftest)
  - `typecheck`: `typecheck:baseline` + `vite build`
  - `unit-tests`: `vitest run --project unit`
  - `db-tests` ×2 shards: `vitest run --project db --shard=i/2` (exact partition; `fileParallelism: false` per runner)
  - `db-rehearsals` ×2 shards: `db:rehearse:all -- --shard=i/2` (round-robin over the discovered inventory)
  - `i18n`: bun en/nl parity
  - `workflow-contract`: `node scripts/ci/workflow-contract.mjs` — the split gate's own contract (every prerequisite really runs its suite once and unweakened; shard matrices stay single-dimension 1..N; the required check keeps the id `test`; npm aliases and the db-project inventory are intact)
  - `edge-tests`: `deno test --no-check` on `_shared/`
  - `edge-typecheck`: `check:edge-types`(+selftest), ratcheted real `deno check`
  - `test`: the aggregator branch protection requires — `if: always()`, one fixed command (`node scripts/ci/verify-prerequisites.mjs`) over one declared input (`NEEDS_JSON: ${{ toJSON(needs) }}`). It succeeds only when every prerequisite — `unit-tests`, both `db-tests` shards, both `db-rehearsals` shards, `i18n` and `workflow-contract` — is present in `needs` **and** reports `success`. A job dropped from `needs:` is simply absent from that JSON, which the validator treats as a failure. The decision is a pure function (`validatePrerequisites`), so it is unit-tested directly rather than by simulating shell runs.
- **`migrations.yml`** (PRs touching migrations/types only): `supabase db reset` + generated-types drift.
- **`e2e.yml`**, **`seo-smoke.yml`**, **`sitemap.yml`**: scheduled/manual, not per-PR.

## Deploy reality (why gates ≠ shipped)

CI validates; it does not deploy DB or edge changes.

- **Frontend** → auto-deploys via Vercel on merge to `main`.
- **DB migrations** → owner applies manually (dashboard SQL editor / `db push`). Agents have no service key.
- **Edge functions** → owner redeploys manually. A green build does NOT mean a fixed edge fn is live.

When a change requires owner action, say so explicitly and point at the relevant runbook (`docs/PHASE*_RUNBOOK.md`, `docs/payments/PAYMENT_RECOVERY_RUNBOOK.md`, `audit/DEPLOY_CHECKLIST.md`).
