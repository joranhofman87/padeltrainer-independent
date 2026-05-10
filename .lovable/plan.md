## Problem

When a trainer (or location) filter is active, the chip below the Week/Day/Month switcher is rendered with neutral background + plain border. It looks like a passive label rather than an active filter, so trainers easily miss that the agenda is scoped to one person and get confused by "missing" data.

Source: `src/pages/academy/AcademyCalendar.tsx` lines 928-950, plus a small helper banner above the agenda content.

## Plan (UI only)

In `AcademyCalendar.tsx`, upgrade the active-filter strip so it reads as a clear, dismissable scope indicator:

1. **Stronger chips** (lines 931-948):
   - Use `bg-primary/10 border-primary/40 text-primary font-medium` (theme tokens, no hardcoded colors).
   - Slightly larger: `px-3 py-1.5 text-sm`.
   - Prefix with a small icon (`User` for trainer chip, `MapPin` for location chip).
   - Keep the `X` to clear, with `aria-label` (e.g. "Clear trainer filter").

2. **Leading label** in front of the chips:
   - Small uppercase muted label `Filtered by` (i18n key `calendar.filteredBy`, with NL fallback "Gefilterd op") so the row clearly signals "the view is narrowed".
   - Trailing "Clear all" link button when more than one filter is active, calling both setters.

3. **Banner above the agenda body** (new, only when `filtersActive`):
   - A compact one-line bar with `bg-primary/5 border border-primary/20 text-primary` that says e.g. "Showing Patrick van der Welle only" / "Showing TPVU only" / combined ("Showing Patrick van der Welle at TPVU"). i18n: `calendar.showingScope` with `{trainer}` / `{location}` interpolation.
   - Right-aligned "Show all" button that resets both filters.
   - Rendered inside the same primary-view container, just before the Day/Week/Month grids, so it's visible regardless of which sub-view is active.

4. **No logic changes**: filter state, query effects, and chip clearing behavior stay as-is. Pure presentation upgrade.

## i18n keys to add (academy.json, all locales)

- `calendar.filteredBy` ("Filtered by" / "Gefilterd op")
- `calendar.clearAll` ("Clear all" / "Alles wissen")
- `calendar.showingScope` ("Showing {{scope}}" / "Toont {{scope}}")
- `calendar.scopeTrainer` ("{{name}}")
- `calendar.scopeTrainerAtLocation` ("{{trainer}} at {{location}}" / "{{trainer}} bij {{location}}")
- `calendar.showAll` ("Show all" / "Toon alles")

## Out of scope

- Changing how the filter is opened (Filters popover stays the same).
- Persisting filter state across sessions.
- Adding new filter dimensions.

## File to edit

- `src/pages/academy/AcademyCalendar.tsx`
- `src/i18n/locales/{en,nl,fr,es,it}/academy.json`
