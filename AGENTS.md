# AGENTS.md

Guidance for AI assistants (and humans) working in this repo. Keep changes focused
and consistent with the existing architecture. Full detail lives in `docs/` — this
is the short version.

## Project

Padeltrainer — a React + TypeScript (Vite) frontend with a Supabase backend
(Postgres + edge functions). Multi-**role** app: trainer, academy, club, player
(+ admin, marketing). The frontend auto-deploys via Vercel on merge to `main`;
DB migrations and edge functions are deployed manually by the owner.

## Frontend rules (most important)

Read [`docs/FRONTEND_ARCHITECTURE.md`](docs/FRONTEND_ARCHITECTURE.md) and
[`docs/UI_COMPONENT_STANDARDS.md`](docs/UI_COMPONENT_STANDARDS.md). The essentials:

1. **Pages are thin wrappers.** Wire data + role context to shared components; don't
   inline reusable UI or business logic in a page.
2. **Use the shared primitives — don't reinvent.** `components/ui` for UI primitives;
   `AppPage`/`PageHeader`/`DataTableCard`/`EmptyState`/`StatTile`/`useTableSort` and
   the shared `components/invoices` + `components/players` for the common patterns.
   Repeated table/date/card/form/status UI **must** reuse these, not be re-built.
3. **Role isolation is enforced.** A role's `components/<role>` and `pages/<role>`
   **must not import another role's** `components`/`pages`. This is an ESLint error
   (`no-restricted-imports`, gated by `npm run lint` in CI). To share across roles,
   lift the code to a neutral folder (`components/ui`, `components/slots`,
   `components/invoices`, `components/players`, …), `hooks/`, or `lib/`.
   (`components/player` = the player role, private. `components/players` = shared.)
4. **Check ALL roles before changing one.** Trainer/academy/club/player mirror each
   other. Before editing a role-specific page or fixing a role bug, `grep` the other
   roles for the same code — fix or share across them, don't patch one in isolation.

## Before you finish

Run and keep green:
- `npm run lint` — ESLint. Pre-existing issues live in `eslint-suppressions.json`
  (a **shrink-only** baseline). **Never add new violations**; when you fix a
  suppressed one, run `npm run lint:prune` and commit the smaller baseline. Do not
  introduce new `any`.
- `npm run build` — Vite production build.
- `npx vitest run` — unit tests for anything you touched.
- `bun scripts/check-i18n-parity.ts` — if you touched i18n keys (en/nl must match).

## Conventions

- Imports use the `@/` alias → `src/`.
- Money/pricing/invoice logic is behaviour-sensitive — preserve it exactly unless the
  task is explicitly to change it; lean on the shared helpers in `lib/`.
- Keep PRs focused; don't refactor large areas as a side effect. If you spot debt,
  note it (see the "Known architecture debt" section in `docs/FRONTEND_ARCHITECTURE.md`)
  rather than expanding scope.
- Commit/push only when asked.
