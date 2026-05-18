# Always-Open Registration Forms

Today every registration is tied to a `start_date`, `end_date` and optional `enrollment_deadline` on the `cycles` table. We want a new flavor: a registration form an academy (or club/trainer) can leave open indefinitely so prospects can apply at any time, and it shows on the location landing page as long as the owner keeps it marked open.

## Approach

Add an `is_always_open` boolean flag on `cycles`. When true:
- The form behaves like a registration (`type = 'registration'`), but date fields are not required and not enforced.
- The cycle form UI greys out / hides the date range + enrollment deadline.
- Public listings (`LocationOpenCycles`, academy/club profile, etc.) show it whenever `status = 'open'`, with no date label.
- Sorting falls back to created/updated date rather than `start_date`.
- Visibility is controlled solely by the owner toggling `status` between `open` and `closed` (or unpublishing).

## Data model

New migration on `public.cycles`:
- `is_always_open boolean not null default false`
- Make `start_date` / `end_date` nullable (currently required) OR keep them required and store a sentinel — preferred: make them nullable, since semantically there is no window.
- No RLS changes needed; existing policies on `cycles` already cover the row.

## Backend / lib changes (`src/lib/cycles.ts`)

- Extend `Cycle` type with `is_always_open: boolean` and make `start_date`/`end_date` nullable.
- `createCycle` / `updateCycle`: pass the flag through, allow null dates when `is_always_open`.
- `getLocationCycles` and any `.order('start_date')`: when `is_always_open`, treat as always-current; sort always-open entries first (or last) by `created_at`.
- `getActiveCycles`: include always-open rows regardless of date.
- Deadline helpers (`isDeadlinePassed`) short-circuit to `false` for always-open.

## Form UI (`src/pages/CycleFormPage.tsx` + cycle form components)

- New checkbox/toggle near the top of the registration form: "Open registration (no fixed dates)".
- When checked:
  - Disable + visually grey out `start_date`, `end_date`, `enrollment_deadline` inputs.
  - Drop their Zod validation (`z.string().optional().nullable()` branch).
  - Show helper copy: "This form stays open until you close it from the registrations list."
- Not available for `type=event` (events inherently have a date).

## Public surfaces

- `LocationOpenCycles`: replace date range chip with an "Open registration" badge when `is_always_open`; hide deadline row.
- Cycles list/table (`CyclesTable`): show an "Always open" pill instead of date range; sort to top.
- Branded cycle registration landing (`BrandedCycleRegistration`): hide "starts on / ends on" copy when always-open.
- SSR (`render-page`) snippets that reference dates need the same conditional.

## i18n

Add keys in all 6 locales under `cycles.json`:
- `alwaysOpen.label` — "Open registration (no fixed dates)"
- `alwaysOpen.help` — explanation copy
- `alwaysOpen.badge` — "Always open"

## Out of scope

- Auto-closing logic (capacity-based) — owner closes manually.
- Changes to event flow.
- New notification cadence for always-open registrations (can follow later).

## Open questions

1. Should always-open registrations still allow per-slot scheduling, or be intake-only (no calendar slots)? Recommendation: intake-only at launch, since slots assume a date window.
2. Should this be allowed for all three owner types (trainer, club, academy) or academies only? Recommendation: all three for parity.
