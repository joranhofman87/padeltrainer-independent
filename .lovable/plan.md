# Code-quality cleanup (items 11–15)

Tackled in order of risk/leverage. Items 14 and 15 are quick, mechanical wins. Items 11–13 are larger and proposed as scoped first passes, not full rewrites.

## #14 — Delete duplicate Supabase client (quick, do first)

We currently ship two `createClient` calls:
- `src/integrations/supabase/client.ts` (auto-generated, must not be edited)
- `src/lib/supabaseClient.ts` (manual, used by ~208 files; only 4 files use the integrations one)

Both have identical auth config (`localStorage`, persist, autoRefresh), so two `GoTrueClient` instances are running for no reason.

**Fix:** Replace the body of `src/lib/supabaseClient.ts` with a pure re-export:
```ts
export { supabase } from "@/integrations/supabase/client";
export type { Database } from "@/integrations/supabase/types";
```
No call-site changes needed; both import paths resolve to the same singleton. Removes the dual-client warning and keeps existing imports working. (We can't delete `integrations/client.ts` — it's auto-generated.)

## #15 — Translation parity check

Current key counts: en 5214, nl 5318, de 4644, fr 4582, es 4739, it 5079.

**Fix in two parts:**
1. Add `scripts/check-i18n-parity.ts` that loads every JSON under `src/i18n/locales/<lang>/`, flattens keys, and diffs each non-en locale against `en`. Exit non-zero with a per-locale list of missing keys (capped output).
2. Wire it into the existing CI workflow (the weekly + PR workflow already in `.github/workflows`) as a fast `bun run i18n:check` step. Add the script to `package.json`.

Backfill is **not** in scope for this task — the check just stops the bleeding. We'll generate a one-time report of missing keys and surface it for triage.

## #11 — God components (first pass, one file)

Five files >1.5k lines. A full break-up of all of them is multi-day work and risky given how interactive they are (TanStack Query optimistic strategy memory, fragile-components memory). Proposal: do **one** as the template this round — `AddSlotDialog.tsx` (1772 lines, narrowest blast radius vs. CycleForm/ProposalScheduleGrid which are flagged as fragile God Components in memory).

Steps:
1. Extract pure sub-components into `src/components/slots/addSlot/`: `SlotBasicsSection`, `SlotScheduleSection`, `SlotPricingSection`, `SlotVisibilitySection`, `SlotConflictsBanner`.
2. Lift form state into a single `useAddSlotForm()` hook (reducer-based) so child components subscribe via context instead of prop-drilling.
3. Memoize each section with `React.memo` and stable callbacks.
4. Keep the public dialog API unchanged — same props, same `onSaved` contract.

CycleForm / ProposalScheduleGrid / TrainerScheduleOverview / AcademyEditDialog stay as-is this round; we'll log them in `.lovable/plan.md` as follow-ups.

## #12 — 51 components calling Supabase directly (scoped first pass)

Full migration is 51 files. First pass: pick the 10 most-touched call-sites and move them behind hooks in `src/hooks/` (or `src/lib/*.ts` data modules where a hook isn't natural). Criteria for the 10: largest by line count + components that re-fetch on every render.

Pattern per migration:
- New `useXxx()` hook returning `{ data, isLoading, error, ... }` via TanStack Query, with a stable `queryKey` and the project's standard `staleTime` + `keepPreviousData` defaults (per memory).
- Component switches from inline `supabase.from(...)` to the hook.
- Mutations get `useXxxMutation()` with `onSuccess` invalidations against the related keys.

Remaining 41 components get tracked as a follow-up list in `.lovable/plan.md`.

## #13 — Zero TODO/FIXME (process item, not code)

Nothing to "fix" in code. Action: append a note to `.lovable/plan.md` recommending a human review pass on the five God Components from #11 before further feature work, and adopt a convention of leaving `// TODO(owner): …` markers when intentionally deferring work. No automation in this task.

## Order of execution

1. #14 client dedupe (5 min, zero risk)
2. #15 i18n parity script + CI wiring (~30 min)
3. #12 first 10 hook migrations
4. #11 `AddSlotDialog` decomposition (largest; do last, verify build + manual smoke of slot-create flow)
5. #13 note appended to plan doc

## Out of scope (logged as follow-ups)

- Breaking up CycleForm, ProposalScheduleGrid, TrainerScheduleOverview, AcademyEditDialog
- Migrating the remaining ~41 direct-Supabase components
- Backfilling missing de/fr/es/it/nl translation keys
