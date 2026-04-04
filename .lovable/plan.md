

# Move Manage Tab Navigation Inline (Match Overview Layout)

## Problem
The Manage tab has its week navigation in the top-right header area (separate from filters), while the Overview tab has navigation + filters in a clean inline row directly above the grid. The user wants visual consistency.

## Changes

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCalendar.tsx` | Hide top-level date nav for `manage` tab (same as overview). Move the week/day navigation into the Manage tab's controls card, inline with the view toggle and filters. Layout: left side = view toggle + nav arrows/label/today, right side = filter dropdowns. Remove the separate stats legend row or keep it minimal below. |

## Layout (after)

```text
Tabs: [Overview] [Open Spots] [Manage] [Trainer Hours]

┌──────────────────────────────────────────────────────────┐
│ [Day][Week]  ◀ 30 mrt - 5 apr ▶ Today  │ [Location▼] [Trainer▼] │
├──────────────────────────────────────────────────────────┤
│ ○ Available: 0   ○ Pending: 0   ○ Booked: 0             │
└──────────────────────────────────────────────────────────┘
```

## Detail
- Hide top-level date nav when `activeTab === "manage"` (add to existing condition that already hides for `overview` and `open-spots`)
- In the Manage tab's Card, restructure the flex row: left group = view toggle buttons + chevron nav + date label + today button; right group = location + trainer dropdowns
- Keep the quick stats legend row below as a subtle border-t section
- Single file change, ~30 lines restructured

