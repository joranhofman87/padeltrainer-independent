## Goal

Replace the ambiguous trainer "dots" on the Agenda month view with meaningful location info, and add a clear top-of-page overview so academy owners can see at a glance: who is training where, who still has free capacity, and how many real training hours are booked vs. still open.

## Scope

Routes: `/app/academy/calendar` (and the analogous trainer agenda where it makes sense to mirror the summary).

Views affected:
- **Month view** (`src/components/academy/AgendaMonth.tsx`) — main visual change.
- **Week-by-trainer view** (`src/components/academy/AgendaWeekByTrainer.tsx`) — small additions for free-capacity indicator parity.
- **Calendar page** (`src/pages/academy/AcademyCalendar.tsx`) — add an overview summary bar above the view tabs.

## Changes

### 1. Month view: drop the trainer hue dots, show location + load

Each day cell becomes:

```text
┌──────────────────────────┐
│ 12              5 sess.  │
│ ──────────────────────── │
│ [logo] Padel Centrum     │
│ [logo] Smashclub  +1     │
│ ──────────────────────── │
│ 12 / 18 spots booked     │
│ 3 spots free  • dot      │
└──────────────────────────┘
```

- Top-right: total sessions that day (already present, kept).
- Body: up to 2 location rows showing `logo_url` (16px) + name (truncated). Overflow shown as `+N`. Falls back to initials avatar if no logo.
- Footer: `bookedSeats / totalSeats spots` plus a small status pill:
  - green "Free spots" when seats remain,
  - amber "Almost full" when ≤2 free,
  - red "Full" when 0 free.
- The colored trainer dots are removed because they did not communicate anything actionable.

### 2. Week-by-trainer view: free-capacity glance

- Each cell already shows `booked/max` in the expanded slot list. Add a tiny "X free" badge in the day-summary area and color the cell border using the same green/amber/red state used in month view, so scanning a row immediately tells the owner which trainers still have openings.
- Trainer row header gets a compact "Hd: Xh booked / Yh free" label for the visible week.

### 3. Calendar page: overview summary bar

Above the week/day/month tabs, add a 4-tile summary scoped to the visible range (week or month, matching active tab):

1. **Active trainers**: count of trainers with ≥1 session, plus avatar stack.
2. **Locations in use**: count of distinct locations, plus logo stack.
3. **Booked hours**: sum of `(end-start) * (booked/max)` across slots — i.e. real training hours sold.
4. **Free hours**: sum of `(end-start) * ((max-booked)/max)` across slots — capacity still open.

Each tile is clickable and scrolls/filters to relevant rows (active trainers tile opens the trainer filter, locations tile opens location filter). No new data fetches — derived from already-loaded `weekSlots` / `monthSlots`.

### 4. Data plumbing

`AgendaSlot` (`AgendaWeekByTrainer.tsx`) gains two optional fields:

```ts
location_id?: string | null;
location_logo?: string | null;
```

`AcademyCalendar.tsx` already fetches locations; extend the slot mapper (both week and month fetchers) to attach `location_logo` from the existing `locations` lookup map. No new query.

## Out of scope

- Day view layout (already shows full slot detail).
- Mobile-only redesigns beyond what falls out naturally; current responsive rules kept.
- Changing how "free / public" vs "private" slot status is computed.

## Files to touch

- `src/components/academy/AgendaMonth.tsx` — replace dot row with location rows + capacity footer.
- `src/components/academy/AgendaWeekByTrainer.tsx` — add free badge, trainer-row hours, extend `AgendaSlot` type.
- `src/pages/academy/AcademyCalendar.tsx` — build summary tiles, pass `location_logo` into slot mappers.
- (Optional, parity) `src/pages/TrainerCalendar.tsx` — same summary tiles if equivalent component exists.
