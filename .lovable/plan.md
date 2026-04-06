

# Action Items Widget for Trainers and Players

## What it does

When trainers or players open their dashboard, the first thing they see is an "Action Required" card listing past sessions that still need attendance reporting. Each item shows the session date, name, and a quick action to confirm/dismiss. Once reported, the item disappears. This replaces the current pattern of burying attendance forms deep inside slot detail or booking pages.

## How it works

### Data query

For **trainers**: fetch past `availability_slots` (where `start_time < now`) that have confirmed bookings but no matching `session_reports` entry from this trainer. Limited to the last 14 days to avoid overwhelming backlog.

For **players**: fetch past `bookings` (via `availability_slots.start_time < now`, status = confirmed/completed) where no `session_reports` entry exists for this player + slot. Same 14-day window.

### UI component

A shared `PendingActionsCard` component rendered at the top of both dashboards (above stats cards). Mobile-first design:

- Compact card with amber/orange accent and a count badge ("3 sessions need your input")
- Each action item is a row: date, session name, two buttons — "Report" (expands inline form) and "Dismiss" (X, marks as skipped)
- The inline form is a simplified version of the existing `TrainerAttendanceForm` / `PlayerAttendanceForm` — toggle for "session happened", quick notes field, save button
- When all items are handled, the card disappears
- Collapsible on mobile — shows count header, tap to expand the list

### Trainer version extras
- Shows player names and attendance checkboxes (who showed up)
- Two note fields (session summary + private notes) — same as existing form

### Player version
- Simpler: just "did the session happen?" toggle + private notes
- Shows trainer's session summary if already submitted (read-only)

## File summary

| File | Change |
|------|--------|
| `src/components/dashboard/PendingAttendanceCard.tsx` | New — shared action items widget with trainer/player mode |
| `src/pages/TrainerDashboard.tsx` | Import and render `PendingAttendanceCard` above stats cards |
| `src/pages/PlayerDashboard.tsx` | Import and render `PendingAttendanceCard` above upcoming bookings |
| Locale JSON files (EN, NL, ES, DE, FR) | Add ~10 translation keys for action items UI |

