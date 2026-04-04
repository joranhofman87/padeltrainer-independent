

# Redesign Overview: Compact, Scannable Week Grid

## Problem
The current overview is too busy:
- Every unique start time (including half-hours) gets its own row, making the grid very tall
- Slot cards are large: they show full trainer name, location text, occupancy bar, and count
- Cards vary in height, making columns look misaligned
- The goal — "quickly scan the week's planning" — is lost in the noise

## Design approach (UX best practice for non-technical users)

**Replace the time-row grid with a simple day-column layout.** Each day is a column, slots stack vertically sorted by time. No time-axis alignment — this eliminates the half-hour row problem entirely and makes the grid compact.

**Minimal slot cards**: Each card is a single fixed-height row showing:
- Trainer avatar (small circle, 20px)
- Time range (`10:00–11:00`)
- Player count as a simple fraction (`3/4`)
- Color-coded left border: green = full, amber = partial, gray = empty

No trainer name text, no location text, no occupancy bar. The avatar IS the trainer identifier. Full/marked-full slots get a green left border only — no bar, no badge.

**Tooltip on hover** reveals full details (trainer name, location, player names) for users who need it.

```text
┌─────────────────────────────────────────────────────────┐
│ ◀  7 – 13 Apr 2026  ▶  Today  [+New]    [Loc▾] [Tr▾]  │
├─────────────────────────────────────────────────────────┤
│  Mon 7    Tue 8    Wed 9    Thu 10   Fri 11   Sat  Sun  │
│ ┌──────┐ ┌──────┐ ┌──────┐                              │
│ │🟢 👤 10:00 3/4│ │🟡 👤 10:00 2/4│ ...                 │
│ │🟢 👤 10:00 4/4│ │   👤 11:00 0/4│                     │
│ │🟡 👤 14:00 2/4│ │🟢 👤 14:00 4/4│                     │
│ │   👤 18:00 0/4│ └──────┘                              │
│ └──────┘                                                │
│                                                         │
│ 🟢 Full  🟡 Partial  ○ Empty                            │
└─────────────────────────────────────────────────────────┘
```

## Changes

| File | Change |
|------|--------|
| `src/components/academy/AcademyCalendarOverview.tsx` | Complete rewrite of the grid and SlotCard |

### SlotCard redesign
- Fixed height (~32px), single flex row
- 3px left border (green/amber/transparent) for status
- Trainer avatar (20px circle) — uses avatar from trainer data passed via props
- Time: `HH:mm–HH:mm` in `text-xs font-medium`
- Count: `3/4` in `text-[10px] text-muted-foreground`, right-aligned
- No occupancy bar, no trainer name text, no location text, no "Full" badge
- Hover tooltip (native `title` attribute): "Trainer Name · Location · 3/4 players"

### Grid layout change
- Remove the `uniqueTimes` time-row system entirely
- Use `grid-cols-[repeat(7,1fr)]` — no time label column
- Each day column: header + vertically stacked slot cards sorted by start_time
- Day header: 3-letter day + date number (existing style)
- Empty days show a subtle "—" placeholder

### Props update
- Add `trainer_avatar` to the `SlotSummary` interface
- Pass trainer avatar data from `AcademyCalendar.tsx` when mapping `overviewSlots`

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCalendar.tsx` | Add `trainer_avatar` to `overviewSlots` mapping (where trainer data is joined) |

### Stats cards
- Keep as-is (they're fine and separate from the grid)

### Legend
- Simplify to match: green dot = Full, amber dot = Partial, gray dot = Empty

