

# Redesign Overview: Trainer-Grouped, Visual-First Layout

## Problem
The current grid is a flat list of 30px rows per slot. With 15+ slots per day, it becomes a wall of identical-looking text. Occupancy is shown as fractions (0/4), avatars are too small to recognize, and there's no grouping — making it very hard for non-technical users to quickly scan the week.

## New Design Concept

### Layout: Trainer swim-lanes within each day column

Instead of listing every slot individually sorted by time, **group by trainer** within each day column:

```text
  MON 13          TUE 14          WED 15
┌──────────────┬──────────────┬──────────────┐
│ 🟢 Marco (5) │ 🟡 Marco (4) │ 🟢 Marco (6) │
│ 10:30-12:00  │ 10:00-11:30  │ 11:30-12:30  │
│ 14:00-15:00  │ 12:30-14:00  │ 12:30-13:30  │
│ 15:00-16:00  │ 14:00-15:00  │ ...          │
│ ...          │ ...          │              │
│──────────────│──────────────│──────────────│
│ 🟡 Sarah (3) │ 🔴 Sarah (2) │              │
│ 18:00-19:00  │ 19:00-20:00  │     —        │
│ 19:00-20:00  │ 20:00-21:00  │              │
│ 20:00-21:00  │              │              │
└──────────────┴──────────────┴──────────────┘
```

Each trainer block shows:
- **Larger avatar** (28-32px) — actually recognizable
- **Trainer first name** (short, next to avatar)
- **Summary dot** — single colored circle for worst status that day (green = all full, amber = some open, red/gray = mostly empty)
- **Session count badge** — e.g. "5 sessions"
- **Time list** — simple text lines with small occupancy dots (●●●○ for 3/4)

### Occupancy: Dot indicators instead of fractions

Replace `0/4` with visual dots:
- `●●●●` = 4/4 (green)
- `●●○○` = 2/4 (amber)  
- `○○○○` = 0/4 (gray)

Max 6 dots. Instantly readable without math.

### Collapsible trainer blocks

Each trainer block is collapsible. Default: expanded if ≤3 trainers per day, collapsed (showing only avatar + summary) if >3. Click to expand.

## Changes

### `src/components/academy/AcademyCalendarOverview.tsx` — Full rewrite of the grid section

**Data grouping:**
- After filtering, group `weekSlots` by day AND trainer: `Map<dayKey, Map<trainerId, SlotSummary[]>>`
- Sort trainer groups by earliest start time within each day

**CompactSlotCard → TrainerDayBlock:**
- New component replacing individual slot cards
- Shows: trainer avatar (h-7 w-7), first name, session count badge, summary status dot
- Below: list of time ranges as simple rows with dot-style occupancy indicators
- Clickable — calls `onDayClick`

**OccupancyDots component:**
- Takes `booked` and `max` numbers
- Renders filled/empty circles (max 6, scale down if max_participants > 6)
- Colors: green for filled, gray for empty

**Keep unchanged:**
- Stats cards row (top)
- Navigation + filters row
- Legend (update to match new dot style)
- All props and interfaces

### No other files changed
This is a self-contained visual refactor of one component.

## Result
- Trainer identity is immediately visible (larger photos, names shown once per group)
- Occupancy is intuitive (dots, not fractions)
- Day columns are shorter (grouped blocks vs individual rows)
- The key question "who's doing what, and is anything empty?" is answerable in seconds

