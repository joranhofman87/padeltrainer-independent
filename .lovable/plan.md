## Goal

Make the academy Players table customizable: show a sensible default set of columns and let the user opt-in to additional columns from a dropdown.

## Default columns (visible out of the box)

1. **Name** (with notes preview kept under the name when Notes column is hidden)
2. **Email**
3. **Phone**
4. **Location** — comma-separated training locations from `location_names`
5. **Date added** — `created_at`

Plus a fixed **Actions** column (always visible, edit / delete dropdown).

## Optional columns (toggleable)

- **Trainer** — `trainer_name`
- **Skill rating** — `skill_rating` + `rating_system` badge
- **Status** — Registered / Active / Prospect badge
- **In active cyclus** — Yes / No (from `has_active_cyclus`)
- **Type** — Guest / Registered
- **Notes** — full notes
- **Source** — `guest_players.source`
- **Birth date** — `guest_players.birth_date`

Birth date / source render a placeholder for registered (non-guest) players.

## UX

- Add a **"Columns"** button (with `Columns3` icon) in the toolbar next to "Add player" / "Import".
- Clicking opens a `DropdownMenu` of `DropdownMenuCheckboxItem`s for each non-fixed column.
- Selection persisted in `localStorage` under `academyPlayers:visibleColumns:{academyId}` per academy.
- Desktop table only. Mobile cards stay unchanged.

## Technical sketch

In `src/pages/academy/AcademyPlayers.tsx`:

1. Define a `COLUMNS` array of `{ key, label, default, fixed?, render(player) }` definitions. Fixed: `name`, `actions`. Default: `email`, `phone`, `location`, `addedOn`.
2. Add `visibleColumnKeys: Set<string>` state, initialized from `localStorage` (fallback to defaults). Persist on change.
3. Replace the hard-coded `<TableHeader>` / `<TableBody>` cells with `.map` over visible column defs (name first, actions last).
4. Add the "Columns" `DropdownMenu` in the toolbar above the table.
5. Keep the under-name notes preview only when the Notes column is hidden.
6. No data-fetching changes needed; `birth_date` and `source` are already returned by `select('*')` on `guest_players`.

## Out of scope

- Billing name / address / BTW columns.
- Mobile card layout changes.
- Column reordering, resizing, server-side persistence.
- Filters, tabs, email campaign tab.

## Files to touch

- `src/pages/academy/AcademyPlayers.tsx`
