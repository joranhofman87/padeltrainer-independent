

# Approve & Book + Send Schedule Notifications

## Overview

Wire up the "Approve & Book all" button on the Proposal Overview page, and add a "Send Schedule Emails" button that appears after booking. Both are manual actions — the academy reviews everything before each step.

## Architecture

```text
ProposalOverviewPage
  ├── [Approve & Book All] → Edge function: finalize-proposals
  │     ├── Confirm proposed_assignments → status 'confirmed'
  │     ├── Create bookings (slot_id + guest_player_id)
  │     └── Update intake_requests.status → 'booked'
  │
  └── [Send Schedule Emails] (appears after booking)
        └── Edge function: send-schedule-notifications
              ├── Fetch booked players + their schedules
              ├── Send 'schedule_notification' email via send-email
              └── Update intake_requests.status → 'notified'
```

## Changes

### 1. New Edge Function: `finalize-proposals`
- Input: `{ cycle_id }`
- Uses service role to:
  - Fetch all intake_requests for the cycle where status = 'proposed'
  - For each, fetch proposed_assignments (status = 'proposed')
  - Update proposed_assignments.status to 'confirmed'
  - Create a `booking` record per assignment (slot_id, guest_player_id from intake_request, status 'confirmed')
  - Update intake_requests.status to 'booked'
- Returns `{ booked: number, bookings_created: number, errors: [] }`

### 2. New Edge Function: `send-schedule-notifications`
- Input: `{ cycle_id }`
- Uses service role to:
  - Fetch cycle details (name, dates, location, owner info)
  - Fetch all intake_requests where status = 'booked', joined with guest_players and proposed_assignments + slots + trainer_profiles
  - Group schedule per player (they may have multiple slots)
  - For each player: call the existing `send-email` function internally with a new type `schedule_notification`
  - Update intake_requests.status to 'notified'
- Returns `{ sent: number, errors: [] }`

### 3. Add `schedule_notification` email type to `send-email`
- New case in the switch statement
- Content: "Your training schedule is ready!" with:
  - Schedule table (day, time, trainer, location)
  - Cycle name and date range
  - CTA: "Create your account" → `https://padeltrainer.ai/app/signup/player`
  - Multilingual (NL/EN/DE/ES/FR)
  - Signed off with academy/trainer name
- Add to EmailRequest type union and SYSTEM_EMAIL_TYPES array

### 4. Update `ProposalOverviewPage.tsx`
- Add state: `pageStatus: 'idle' | 'booking' | 'booked' | 'sending' | 'notified'`
- Wire "Approve & Book all" button to call finalize-proposals edge function
- After success, show "Send Schedule Emails" button
- Add confirmation dialogs (AlertDialog) for both actions
- Show toast results (X booked, X emails sent)
- Disable buttons during processing, show spinners

### 5. Add helper functions to `src/lib/cycles.ts`
- `finalizeProposals(cycleId)` — invokes finalize-proposals
- `sendScheduleNotifications(cycleId)` — invokes send-schedule-notifications

### 6. Update `src/lib/email.ts`
- Add `schedule_notification` to EmailType union

## Files

| File | Action |
|------|--------|
| `supabase/functions/finalize-proposals/index.ts` | **New** |
| `supabase/functions/send-schedule-notifications/index.ts` | **New** |
| `supabase/functions/send-email/index.ts` | Add `schedule_notification` type + template |
| `src/pages/ProposalOverviewPage.tsx` | Wire up buttons, state machine, confirmation dialogs |
| `src/lib/cycles.ts` | Add `finalizeProposals` and `sendScheduleNotifications` |
| `src/lib/email.ts` | Add type to union |

