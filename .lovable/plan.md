

# Session Attendance & Confirmation System

## Overview

After a training session ends, both the **trainer** and the **players** can report what happened: did the session take place, who showed up, and optionally add notes about what was practiced. This creates a two-sided verification system where the academy owner gets reliable data about actual worked hours.

## How it works

### Data model

A new `session_reports` table stores one report per (slot + reporter):

```text
session_reports
├── id (uuid, PK)
├── slot_id (uuid, FK → availability_slots)
├── reporter_id (uuid, FK → profiles)  -- who submitted this report
├── reporter_role ('trainer' | 'player')
├── session_happened (boolean)          -- did the session take place?
├── attendees (uuid[])                  -- profile IDs of players who showed up
├── notes (text, nullable)              -- what was practiced / reason for cancellation
├── created_at (timestamptz)
└── updated_at (timestamptz)
```

**Why one table instead of separate trainer/player tables?** Same schema, same RLS pattern, simpler queries. The `reporter_role` column distinguishes who reported.

### UX flow

**For trainers** (after a past session):
1. On the slot detail page and schedule overview, past sessions show an "Attendance" section
2. Quick toggle: "Session happened?" (defaults to yes)
3. Checkboxes for each booked player — tick who showed up
4. Optional notes field (e.g., "Worked on volleys and positioning")
5. Single "Save" button

**For players** (after a past session):
1. On the Player Bookings page, past bookings show a "Confirm attendance" prompt
2. Simple: "Did this session happen?" Yes/No
3. Optional notes field
4. Single "Save" button

**Visual indicators:**
- Slots/bookings that need attendance reporting show a small clipboard icon
- Already-reported slots show a green checkmark
- Conflicting reports (trainer says happened, player says no) show a warning indicator on the academy side

### Academy owner view

On the slot detail page, a new "Attendance" card shows:
- Trainer's report (happened/not, who attended, notes)
- Each player's confirmation (happened/not, notes)
- Conflicts highlighted if trainer and player disagree
- This feeds into the Reports tab for accurate worked-hours calculations

### Impact on reporting

The existing Reports tab (`AcademyReports`) currently counts hours based on slots with bookings. With attendance data available, it can optionally filter to only count sessions that were confirmed as having happened — giving the academy owner the "actual worked hours" they requested.

## Migration

```sql
CREATE TABLE public.session_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid REFERENCES availability_slots(id) ON DELETE CASCADE NOT NULL,
  reporter_id uuid REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  reporter_role text NOT NULL CHECK (reporter_role IN ('trainer', 'player')),
  session_happened boolean NOT NULL DEFAULT true,
  attendees uuid[] DEFAULT '{}',
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (slot_id, reporter_id)
);

ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY;

-- Trainers can report on their own slots
CREATE POLICY "Trainers can manage their slot reports"
  ON session_reports FOR ALL TO authenticated
  USING (
    reporter_id = get_profile_id_for_user(auth.uid())
    OR EXISTS (
      SELECT 1 FROM availability_slots s
      JOIN trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = slot_id AND tp.user_id = auth.uid()
    )
  );

-- Players can report on slots they're booked on
CREATE POLICY "Players can manage their booking reports"
  ON session_reports FOR ALL TO authenticated
  USING (
    reporter_id = get_profile_id_for_user(auth.uid())
  );

-- Academy managers can read all reports for their trainers
CREATE POLICY "Academy managers can read reports"
  ON session_reports FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM availability_slots s
      JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
      JOIN academy_managers am ON am.academy_profile_id = at.academy_profile_id
      WHERE s.id = slot_id AND am.user_id = auth.uid()
    )
  );
```

## File summary

| File | Change |
|------|--------|
| Migration SQL | Create `session_reports` table with RLS |
| `src/pages/academy/AcademySlotDetail.tsx` | Add "Attendance" card showing trainer report + player confirmations, with edit capability for the trainer |
| `src/pages/PlayerBookings.tsx` | Add attendance confirmation prompt on past bookings |
| `src/pages/TrainerScheduleOverview.tsx` | Add attendance indicator + quick-report on past slots |
| `src/components/trainer/CalendarSlotCard.tsx` | Show attendance status icon on past slots |
| Locale JSON files (EN, NL, ES, DE, FR) | Add ~25 translation keys for attendance feature |

