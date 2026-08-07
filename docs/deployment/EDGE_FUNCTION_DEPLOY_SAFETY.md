# Edge Function Deploy Safety

How the padeltrainer deploy pipeline actually behaves, and the safe procedure for shipping money-path
changes. Grounded in the real pipeline (see [[padeltrainer-deploy-pipeline]] operational history).

**Project:** `joranhofman87/padeltrainer-independent` · **Supabase (prod):** `ficwbdrzefmblkbkomzw`
(Padeltrainer-production, `eu-central-1`).

---

## 1. What auto-deploys and what does NOT

| Layer | Auto-deploys on merge to `main`? | How it ships |
|---|---|---|
| **Frontend (Vercel)** | ✅ **Yes** | Vercel production build on merge to `main` (project `padeltrainer-independent`). Reaches customers within minutes. |
| **DB migrations** | ❌ **No** | CI (`.github/workflows/migrations.yml`) only **validates** via `supabase db reset` on a throwaway DB + `gen types`. It does **not** `db push` to prod. A committed migration sits **unapplied** until someone runs `supabase db push --linked`. |
| **Edge functions** | ❌ **No** | Must be deployed manually with `supabase functions deploy <slug>`. CI's `test:edge` only runs the Deno tests in `supabase/functions/_shared/`. |
| **`src/integrations/supabase/types.ts`** | ❌ **No** | Regenerate with `supabase gen types typescript --local` after a schema change (or pull the CI `types-generated` artifact). The types-drift gate is green since the 2.107.0 CLI pin — do **not** merge `--admin` (stale perma-red guidance removed 2026-08-07); `as never` casts remain only a stopgap for not-yet-typed RPCs/columns. |

**Consequence:** merging a money-path PR makes the **frontend** live immediately but leaves **migrations
and edge functions unapplied**. That gap is the #1 source of production payment breakage — see §4.

---

## 2. Detecting what a PR changes

Before merging, know exactly what needs a manual deploy step:

```bash
# Changed edge functions in this branch vs main:
git diff --name-only main...HEAD -- 'supabase/functions/**' | sed 's#supabase/functions/\([^/]*\)/.*#\1#' | sort -u

# Changed migrations:
git diff --name-only main...HEAD -- 'supabase/migrations/**'

# Did a _shared/ helper change? Then EVERY edge fn that imports it must be redeployed:
git diff --name-only main...HEAD -- 'supabase/functions/_shared/**'
```

A change under `supabase/functions/_shared/**` is deceptive: the diff touches one file, but **every
function that imports it ships stale code until redeployed.** Grep importers:
`git -C . grep -l "_shared/<file>" supabase/functions`.

---

## 3. Checking what is currently deployed

```bash
# List deployed functions + their version numbers + last-updated:
supabase functions list --project-ref ficwbdrzefmblkbkomzw

# Confirm a specific one:
supabase functions list --project-ref ficwbdrzefmblkbkomzw | grep <slug>

# Migration state (Local vs Remote columns; "up to date" = nothing pending):
supabase db push --dry-run --linked        # read-only — shows exactly what WOULD apply
supabase migration list --linked
```

`functions list` needs `--project-ref` (NOT `--linked`). `functions deploy` works despite a
`WARNING: Docker is not running` (it bundles + uploads server-side).

---

## 4. Safe deploy order (the money-path rule)

**Migrations → edge functions → (frontend already auto-deployed).** Rationale below.

### 4a. Migration BEFORE function
An edge function that reads/writes a **new column** or calls a **new RPC** will error at runtime if the
migration is not applied first. Always:

```bash
git checkout main && git pull --ff-only     # deploy the MERGED code, not a stale branch (see §4c)
supabase db push --dry-run --linked         # confirm scope: EXACTLY the intended new migrations
supabase db push --linked                    # apply
supabase db push --dry-run --linked         # verify: "Remote database is up to date."
```

If `db push --dry-run` lists **more** migrations than you expect, STOP — the tracking table has drifted
(migrations applied out-of-band via the SQL editor are not recorded, so `db push` wants to re-run
already-live ones, which can fail on a non-idempotent statement). Fix with:
`supabase migration repair --status applied <the already-live versions> --linked`, then `db push` the
genuinely-new ones. Do **not** blind-`db push` through drift.

### 4b. Function-before-frontend risk
The frontend **auto-deploys on merge**, but its new edge function is **not yet deployed**. So between
merge and manual deploy, the live frontend can call a function that returns 404 / old behavior. Mitigate:
- **Graceful fallback** in the frontend (try new signature, fall back to old) so it can merge before the
  function is live without breaking — the established pattern.
- Or deploy the function **immediately** after merge.
- A brand-new function called behind a flag / a new route is lower-risk (nothing calls it until wired).

### 4c. `functions deploy` ships your LOCAL working tree, NOT `main`
Redeploying from a feature branch (or a stale `main`) silently ships the **wrong code**. Order:
**merge PR → `git checkout main && git pull --ff-only` → deploy.** Verify by grepping the deployed
behavior and reading the upload manifest (a `_shared/*.ts` appearing/disappearing tells you whether the
new import shipped).

### 4d. The deno.land bundle gotcha
`supabase functions deploy` bundles server-side and fetches `https://deno.land/std@…` imports with a 10s
timeout. When deno.land is slow/down the deploy dies (`Failed to bundle... timed out`). Functions using
native **`Deno.serve`** have no such fetch and deploy fine. **Prefer `Deno.serve` in new edge functions;**
if a deploy fails on a deno.land fetch, it's the network, not the code — retry or migrate that import.

### 4e. A CDN import must name an EXACT version — the specifier IS the defect

**Rule: no external import that can enter a deployment bundle may contain a version range.** `@2` is a
range. `@2.0` is a range. `^2.57.2` is a range. `@2.57.2` is a version. Enforced by
`npm run check:edge-pins` (see [QUALITY_GATES.md](../QUALITY_GATES.md)).

**What happened (2026-08-06).** The N0–N7 inert deployment partially failed: 15 of 18 functions would
not deploy. Nothing in our code had changed to cause it. `https://esm.sh/@supabase/supabase-js@2`
resolved that hour to a build depending on `@supabase/postgrest-js@2.112.2` — a version npm had not
published — so the bundle could not be built.

**Why this is not "upstream was broken".** Three observations from the same run refute that reading:

- `mollie-webhook` carries the *same* floating specifier and deployed **successfully** in that run.
- The two functions that pin exactly (`notif-manage`, `notif-unsubscribe-one-click`) deployed cleanly.
- Within hours, `postgrest-js@2.112.2` **was** published and became the `latest` tag — the same
  specifier that failed the deploy would now succeed.

So the build outcome was decided by what a third party's mutable pointer resolved to at that moment.
A deploy that succeeds or fails according to a CDN's clock is not reproducible, and the failure lands
at deploy time, on a release, with no local reproduction.

**Why local checks could not have caught it — the important part.** `deno.lock` *did* pin the floating
specifier, to `https://esm.sh/@supabase/supabase-js@2.108.2`. Local `deno check`, the edge tests and CI
therefore all resolved 2.108.2, deterministically and successfully. **`supabase functions deploy`
bundles server-side and never sees `deno.lock`.** That is the whole gap: the lockfile made every local
surface reproducible and left the one surface that ships unpinned. A green CI proved nothing about the
deploy, and could not have. Pinning in the source specifier is the only place the deploy bundler reads.

**Which version, and why it is 2.108.2.** `deno.lock` had been resolving the floating specifier to
`2.108.2`, so every local `deno check`, every edge test and every CI run in this repository has been
validated against that version — it is the most exercised version we have, and it is one minor
release from what the deploy was actually fetching. An earlier attempt pinned `2.57.2` (the version
29 functions already named) and that was **wrong**, for a reason no type-check could see:
`auth.getClaims()` in auth-js 2.71.1 THROWS on an expired or exp-less JWT, where 2.108.2 returns
`{data: null, error}`. Seven functions destructure `{data, error}` and branch on `error`; six of them
have `verify_jwt = false`, so `getClaims` is their only gate and every expired token — a routine
client condition — would have become an uncaught 500. Verified by running both versions, not read
off a changelog. **When choosing a pin, diff the RUNTIME behaviour of the APIs you actually call,
not just the types.**

**Use the `https://esm.sh/…` form, not `npm:`.** `scripts/check-edge-deno.mjs` runs
`deno check --node-modules-dir=manual`, which resolves an `npm:` specifier against the
`node_modules` that `npm ci` populated. So `npm:@supabase/supabase-js@2.57.2` cannot resolve when
`package.json` installs `^2.90.1` — deno fails with `Could not find a matching package`, produces no
`TS####` line, and the gate counted **zero errors** for that file. Fourteen entrypoints silently
stopped being type-checked and the ratchet read it as an improvement. A URL specifier is resolved
from the network/cache instead, so it is immune to that skew, and one form repo-wide also removes
the two-module-identity problem below. The gate now fails closed on any non-type `deno` error.

**Scope: `_shared/` counts.** A shared module is bundled into every function that imports it. Five of
the fifteen failures had clean entrypoints and inherited the floating specifier transitively through
`_shared/auth.ts`, `_shared/booking-access.ts`, `_shared/booking-confirmation-email.ts` and
`_shared/mollie-booking-paid-side-effects.ts`. Pin the shared modules or the guard is theatre.

**A `./cors` subpath DOES exist.** supabase-js publishes `./cors` from 2.95.0 (2026-02-05) onward.
`send-campaign-emails` imports it and always has resolved at deploy time, because it named the
floating `@2`. Do not "repair" it to `_shared/cors.ts`: upstream sends
`Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS` and `_shared/cors.ts` sends no
Allow-Methods at all, which a browser preflight needs to permit a cross-origin POST. Probing an old
pinned version makes the subpath look nonexistent — check the version the deploy actually resolves.

**One package, one specifier form.** `npm:@supabase/supabase-js@2.57.2` and
`https://esm.sh/@supabase/supabase-js@2.57.2` are the *same library at the same version* but two
distinct module identities to TypeScript, so a client created from one cannot be passed to a helper
typed against the other. Prefer the `https://esm.sh/…` form used by the majority of this repo, and
never mix forms across an entrypoint and the `_shared/` modules it calls.

**A computed specifier is a violation too.** `import(`npm:pkg@${v}`)`, `import("npm:pkg@" + v)` and
`import(spec)` cannot be exact pins by construction — there is no version in the source for anyone
to check. The guard reports them in their own right.

**Why the guard parses instead of grepping.** It originally used regexes, and three consecutive
review rounds each found a fresh hole in the same place: an attributed dynamic import, a `;` inside
a comment ending the import clause, a computed specifier, a call to a method named `import`, a
comment-stripper that desynced on a regex literal containing a quote, `import(` matched inside a
string. Each patch was locally correct and the family kept producing defects. Deciding what is code,
what is a comment, what is a string and what is a regex literal *is* parsing, so the guard now uses
the TypeScript parser and fails closed on any file it cannot parse. If you extend it, extend the AST
walk — do not reintroduce a pattern.

**Avoid `ReturnType<typeof createClient>` for a client parameter.** It instantiates the *default*
generics, which differ between supabase-js versions, so it breaks on any version bump. Import the type
instead: `import { createClient, type SupabaseClient } from "…"` and annotate the parameter
`SupabaseClient`.

---

## 5. Deploy commands (copy-paste)

```bash
cd /Users/tom/Cursor/padeltrainer
git checkout main && git pull --ff-only

# 1) Migrations (if any)
supabase db push --dry-run --linked      # confirm scope
supabase db push --linked

# 2) Edge functions (one per changed slug)
supabase functions deploy <slug> --project-ref ficwbdrzefmblkbkomzw

# 3) Verify
supabase db push --dry-run --linked      # → "Remote database is up to date."
supabase functions list --project-ref ficwbdrzefmblkbkomzw | grep <slug>
```

---

## 6. Verifying after deploy — WITHOUT side effects

**Never invoke a live money or email function as a smoke test.** `create-mollie-payment`,
`create-invoice-payment`, `create-*-rebook-invoice*`, `create-guest-*-payment`, `auto-create-invoice`,
`send-invoice-email`, `send-priority-claim-invitation`, `send-rebook-reminder`,
`send-rebook-group-confirmation`, `mollie-webhook` — invoking these creates real payments / sends real
emails / mutates real bookings.

Safe verification:
- `supabase functions list` shows the **version incremented** + a fresh `updated` timestamp.
- The Supabase dashboard → Functions → the function → **Logs** (a real user's next action produces logs
  you can read; you don't trigger it yourself).
- For migrations: `db push --dry-run` says "up to date"; the schema change is queryable read-only (e.g.
  `pg_get_functiondef` for an RPC redefinition, or the anon publishable key for a public read).
- A dedicated **read-only reconciliation** report (see `docs/payments/PAYMENT_RECONCILIATION_PLAN.md`)
  is the right post-deploy health check — it reads state, never mutates.

---

## 7. Rollback / redeploy strategy

- **Edge function:** there is no one-command rollback. Redeploy the **previous** code:
  `git checkout <last-good-sha> -- supabase/functions/<slug>` → `supabase functions deploy <slug>` →
  restore working tree. Because deploy ships the working tree, checking out the old file + deploying is
  the rollback.
- **Migration:** migrations are forward-only in practice; write a **compensating** migration (a new
  `CREATE OR REPLACE` reverting the function body, or an `ALTER … DROP`) rather than trying to "unapply".
  Never hand-edit the applied migration file after it shipped.
- **Frontend:** revert the PR on `main` → Vercel auto-rebuilds the previous state.

---

## 8. Money-path PR checklist

Run through this before considering a money-path change "done" (and record the answers in the PR):

- [ ] **Migrations applied?** `supabase db push --dry-run --linked` → "Remote database is up to date."
- [ ] **`supabase db reset` (CI) green?** — the real migration gate; a red here means the migration is broken.
- [ ] **Supabase types regenerated?** — the types-drift gate is green (no perma-red exception); ship the regenerated `types.ts` with the migration.
- [ ] **Every changed edge function deployed?** `functions list` shows a new version for each.
- [ ] **`_shared/` change → all importers redeployed?**
- [ ] **`mollie-webhook` deployed** if the confirm path or recipient resolution changed?
- [ ] **Payment-email functions deployed** if invoice/email content changed (`send-invoice-email`, invite/reminder fns)?
- [ ] **No function writes/reads a column or RPC that isn't live yet?** (migration deployed first)
- [ ] **No auto-deployed frontend calls a not-yet-deployed function without a graceful fallback?**
- [ ] **Charge-org == confirm-org** preserved if recipient resolution changed (both charge + webhook + verify sides)?
- [ ] **Smoke check is non-side-effecting** (functions list + logs + reconciliation; NOT invoking money/email fns)?
- [ ] **Deployed from `main` after `git pull --ff-only`** (not a feature branch)?

---

## 9. Reference

- Operational deploy history + gotchas: memory `padeltrainer-deploy-pipeline`.
- Money invariants the deploy must not break: `docs/payments/PAYMENT_INVARIANTS.md`.
- Post-deploy health check: `docs/payments/PAYMENT_RECONCILIATION_PLAN.md`.
- The full money-flow map: `docs/payments/PAYMENT_FLOW_MAP.md`.
