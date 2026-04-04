

# Fix Overview Tab Layout: Move Navigation + Fix Slot Cards

## Issues
1. **Week switcher sits above stat cards** — should be directly above the calendar grid, inline with filters
2. **Slot cards visually incomplete** — the cards are cut off / not properly contained (see screenshot with red line between days)

## Changes

| File | Change |
|------|--------|
| `src/components/academy/AcademyCalendarOverview.tsx` | Move filters inline with a new row that also receives week navigation props; add proper card borders/padding; ensure day columns have consistent min-height and full borders |
| `src/pages/academy/AcademyCalendar.tsx` | For the overview tab, move the date navigation **inside** the `AcademyCalendarOverview` component instead of rendering it in the top-level tab header. Pass `navigatePrevious`, `navigateNext`, `goToToday`, `dateLabel` as props |

## Layout (after fix)

```text
┌─────────────────────────────────────────────────────┐
│ [Stats row: Sessions | Fill | Open | Booked]        │
├─────────────────────────────────────────────────────┤
│ ◀ 30 mrt - 5 apr 2026 ▶ Today  │ [Location▼] [Trainer▼] │
├─────────────────────────────────────────────────────┤
│  MON   TUE   WED   THU   FRI   SAT   SUN           │
│  30    31     1     2     3     4     5              │
│ ┌───┐                                               │
│ │...│  —     —     —     —     —     —              │
│ └───┘                                               │
└─────────────────────────────────────────────────────┘
```

## Detail

**`AcademyCalendar.tsx`**:
- Hide the top-level date nav when `activeTab === "overview"` (already hidden for "open-spots")
- Pass `onNavigatePrevious`, `onNavigateNext`, `onGoToday`, `dateRangeLabel` props to `AcademyCalendarOverview`

**`AcademyCalendarOverview.tsx`**:
- Add navigation props and render the week switcher + filters in a single row between stats and the grid
- Layout: left-aligned week nav (◀ label ▶ Today), right-aligned filter dropdowns
- Fix slot cards: add explicit `border rounded-lg` styling, ensure each day column has a light separator or consistent background so cards don't visually bleed into adjacent columns
- Add `min-h-[60px]` to empty day columns so the grid maintains structure
- Ensure the card container has proper padding so cards aren't clipped at edges

