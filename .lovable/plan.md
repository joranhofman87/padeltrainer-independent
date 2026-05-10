## Goal
Make every row in the Cycles table render on a single fixed-height line, matching the style used by the Players table.

## Changes (single file: `src/pages/academy/AcademyCyclusOverview.tsx`)

Apply the same per-cell pattern Players uses: `whitespace-nowrap` + `max-w-[…]` + `truncate` + `title` for the full value on hover. Keep `h-8` on `TableRow`.

### Per-column updates (rows ~775–806)

- **Naam**: keep `max-w-[200px]`; ensure inner wrapper is `min-w-0` so `truncate` works next to the type badge. Add `title={group.cyclus_name}`.
- **Trainer**: `whitespace-nowrap max-w-[160px] truncate` + `title={group.trainer_name}`.
- **Locatie**: `whitespace-nowrap max-w-[180px] truncate` + `title={group.location_name}`.
- **Dag / Tijd**: already nowrap — leave as is.
- **Periode**: already nowrap — leave as is.
- **Sessies**: unchanged.
- **Spelers**: rewrite to mirror Players' truncated list pattern:
  - Replace the current `flex` block that prints up to 3 comma-joined names with a single truncated string of all names (`group.player_names.join(', ')`) inside `max-w-[240px] truncate` + `title=` full list, with the `Users` icon kept inline and `+N` badge removed (or kept as a subtle count next to the icon — choose one and apply consistently). Recommended: drop `+N` and rely on truncate + tooltip, like Players does for emails/locations.
- **Prijs**: unchanged (already nowrap).
- **Bezetting (status badge)**: add `whitespace-nowrap`.

### Header row
Add `whitespace-nowrap` to each `TableHead` (matches Players line 942) so headers don't wrap either.

## Out of scope
- No data/business-logic changes.
- Mobile card view (below `md`) untouched.
- No new columns or sorting changes.