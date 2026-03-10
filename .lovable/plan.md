

## Proposal Schedule Grid View

### Problem
The current proposals view is a flat registration table with tiny inline indicators. It is hard to see the overall schedule, spot gaps, or understand what each trainer's day looks like. Managers need a visual, time-based view organized by day and trainer.

### Design

Add a **new tab/view toggle** on the intake requests pages (Academy + Trainer) that switches between the existing "Registrations" table and a new "Schedule" grid view. The grid shows proposals laid out as a weekly timetable.

#### Schedule Grid Layout

```text
┌──────────┬──────────────────┬──────────────────┬─────────────┐
│  Time    │  Trainer A       │  Trainer B       │  Trainer C  │
├──────────┼──────────────────┼──────────────────┼─────────────┤
│  09:00   │  ┌────────────┐  │                  │             │
│          │  │ Jan (4.5)  │  │                  │             │
│  09:30   │  │ +2 others  │  │                  │             │
│          │  │ 87%        │  │                  │             │
│  10:00   │  └────────────┘  │  ┌────────────┐  │   (gap)     │
│          │                  │  │ Kees (3.0) │  │             │
│  10:30   │    (gap)         │  │ 72%        │  │             │
│          │                  │  └────────────┘  │             │
│  11:00   │  ┌────────────┐  │                  │             │
│          │  │ Lisa (5.0) │  │                  │             │
│  11:30   │  └────────────┘  │                  │             │
└──────────┴──────────────────┴──────────────────┴─────────────┘
         ← Mon  Tue  Wed  Thu  Fri →  (day tabs)
```

- **Columns** = trainers assigned in proposals
- **Rows** = 30-minute time increments (only showing the range that has slots)
- **Blocks** = proposal cards spanning the correct time, showing player name, rating, confidence score, group members
- **Gaps** = empty cells clearly visible, highlighted with a subtle dashed border or different background
- **Day tabs** at the top to switch between days of the week
- Clicking a block opens the existing `IntakeRequestDetailSheet`

#### Data Changes

Extend `ProposalDetails` to also include `trainer_id` and raw `slot_start`/`slot_end` timestamps (already available in the query, just not exposed). This allows the grid to position blocks correctly.

### Files to create/edit

1. **Create** `src/components/cycles/ProposalScheduleGrid.tsx` — the day/trainer grid component
2. **Edit** `src/lib/cycles.ts` — add `trainer_id`, `slot_start`, `slot_end` to `ProposalDetails`
3. **Edit** `src/pages/academy/AcademyIntakeRequests.tsx` — add view toggle (Table / Schedule), render grid when "Schedule" is selected
4. **Edit** `src/pages/TrainerIntakeRequests.tsx` — same view toggle

### Interaction

- Toggle between "List" and "Schedule" views via segmented control next to the status filter tabs
- Schedule view only shows requests that have proposals (status = proposed/confirmed)
- Day tabs default to the first day that has proposals
- Empty time slots between proposals are visually distinct so gaps are immediately obvious
- No drag-and-drop initially (future feature) — just read-only visualization with click to open detail

