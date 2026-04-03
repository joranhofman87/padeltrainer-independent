

# Make Intake Requests Table Horizontally Scrollable + Column Visibility Toggle

## Problem
The table hides columns on smaller screens (`hidden md:table-cell`, `hidden lg:table-cell`, `hidden sm:table-cell`), and some data fields (phone, notes, sessions/week, preferred duration, birth date, location) are never shown at all.

## Changes

### `src/components/cycles/IntakeRequestsTable.tsx`

1. **Horizontal scroll**: Remove all `hidden md:table-cell` / `hidden lg:table-cell` / `hidden sm:table-cell` responsive hiding classes. Wrap the table in a container with `overflow-x-auto` so all columns are always rendered and the user scrolls horizontally on smaller screens.

2. **Column visibility dropdown**: Add a `DropdownMenu` button (using the existing `Settings2` or `Columns` icon) above/beside the table that lists all available columns with checkboxes. Store visible columns in component state (default: current columns visible). When unchecked, the column header and cells are not rendered.

3. **Add missing data columns** (hidden by default):
   - Phone
   - Sessions/week
   - Duration (preferred_duration_minutes)
   - Birth date
   - Notes
   - Location

### Column list with defaults

| Column | Default visible |
|--------|----------------|
| Player | Yes (always, not toggleable) |
| Lesson Type | Yes |
| Rating | Yes |
| Availability | Yes |
| Pref. Trainer | Yes |
| Status | Yes |
| Linked | Yes |
| Proposed Assignments | Yes |
| Applied | Yes |
| Phone | No |
| Sessions/week | No |
| Duration | No |
| Birth date | No |
| Notes | No |

### Implementation
- Use `useState` with a `Set<string>` of visible column keys
- Persist preference in `localStorage` under a key like `intake-table-columns`
- Render column toggle as a `DropdownMenu` with `DropdownMenuCheckboxItem` for each column
- Place the toggle button in a small toolbar row above the table (or pass it up to the parent — but keeping it self-contained in the component is simpler)

### Files changed

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestsTable.tsx` | Add horizontal scroll, column visibility toggle, new optional columns |

