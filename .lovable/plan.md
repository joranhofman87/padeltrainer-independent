## Goal

Make the academy Players table dense (Google Sheets feel) so more rows fit on screen, without losing readability.

## Changes (desktop table only)

In `src/pages/academy/AcademyPlayers.tsx`:

1. **Tighter row height**
   - Override default shadcn `TableCell` padding (`p-4`) with `py-1.5 px-3` on every cell.
   - Same on `TableHead` (`h-9 py-1 px-3` instead of default `h-12`).
   - Result: ~32-36px row height instead of ~64px.

2. **Single-line cells**
   - Wrap text cells in `truncate` + `max-w` so long emails / notes / locations don't wrap onto a second line. Add `title={value}` for full text on hover.
   - Date column: switch from `MMM d, yyyy` (which is wrapping to 3 lines like "Apr / 16, / 2026" in narrow columns) to `dd-MM-yyyy` — short, single line, locale-neutral.
   - Email/Phone cells: drop the inline icon (or keep icon but force `whitespace-nowrap`) so the row stays one line.

3. **Compact badges**
   - Status / Cyclus / Type / Skill rating badges: add `h-5 px-1.5 text-[11px]` so they don't inflate row height.

4. **Card chrome trimmed**
   - Remove the `Gastspelers` `CardHeader` (title + "330 spelers beheerd door jou") — that count is already shown in the page header. Keeps more vertical space for rows.
   - Reduce `CardContent` padding to `p-0` and let the table sit flush; add a thin border-top only.

5. **Sticky header**
   - Add `sticky top-0 bg-background z-10` to `TableHeader` so column titles stay visible while scrolling the long list.

## Out of scope

- Column reordering / resizing / inline editing.
- Mobile card layout (already compact).
- Virtualized scrolling (330 rows render fine without it).
- Changing which columns are visible by default.

## Files to touch

- `src/pages/academy/AcademyPlayers.tsx`
