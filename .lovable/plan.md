## Goal
Compact the Players page header so the table appears higher on the screen, matching the layout pattern used on the Registrations / Cycles page (title on the left, primary action buttons on the same row on the right). Reorder the toolbar so search comes first and filters sit next to it.

## Reference layouts

**Cycles page (target pattern)** — one row:
```
[ Title + subtitle ]                         [ Primary action buttons ]
```

**Players page today** — five stacked rows:
1. Title + count
2. Tabs (All Players / Create / Email Campaign)
3. Filters: Trainers, Locations, Levels, Cyclus, Tags, Payments
4. Search + (right-aligned) Columns / Tags / CSV import / Add player
5. Table

## New Players page layout

Row 1 — Header (matches Cycles):
```
Players                                      [ Tags ] [ CSV import ] [ Add player ]
330 players                                                                [ Columns ]
```
- Title + "330 players" subline on the left.
- Action buttons (`Tags`, `CSV import`, `Add player`) move up next to the title.
- `Columns` chooser stays grouped with these (or as the first item); it's a view setting so it can sit just before the filter row instead — one of the small choices to make during build.

Row 2 — Tabs (`All Players` / `Create` / `Email Campaign`) stay where they are but sit directly under the header with no extra spacing block.

Row 3 — Toolbar inside the All Players tab, single row, search-first:
```
[ 🔍 Search players… ] [ Trainers ] [ Locations ] [ Levels ] [ Cyclus ] [ Tags ] [ Payments ]
```
- Search input is the first item, flexible width with a sensible max.
- All filter selects follow it on the same line.
- The right-side button cluster (Columns / Tags / CSV / Add) is removed from this row because those buttons moved into the header. `Columns` can either join the header or sit at the far right of this filter row — pick whichever keeps the row from wrapping at 1280px+.

Row 4 — Table (now visible higher on the page).

Mobile (<sm):
- Header collapses: title block on top, action buttons below as a wrap row (current pattern from Cycles page).
- Toolbar wraps: search full width, filters wrap to a second line — same `flex-wrap` behaviour as today.

## Trainer parity
The Trainer-Academy parity rule applies. Apply the same header restructure to `src/pages/TrainerPlayers.tsx`:
- Move `Import` and `Add player` buttons into the header row (they're already there, but separated from the back arrow / title block — keep them grouped).
- Toolbar already has search-first + filter chips next to it; minor cleanup only to ensure visual consistency with the Academy version.

## Files to edit
- `src/pages/academy/AcademyPlayers.tsx` — restructure header + toolbar (lines ~730–905).
- `src/pages/TrainerPlayers.tsx` — verify/align header and toolbar pattern (lines ~365–425).

No new components, no new dependencies, no data-fetching changes. Pure presentation refactor.

## Out of scope
- Functionality of filters, tabs, columns, tags, import, add player — unchanged.
- The Create and Email Campaign tabs' inner content — unchanged.
