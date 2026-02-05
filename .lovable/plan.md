
# Player Booking & Availability System Enhancement

This plan outlines the three core pathways for players to engage with academies, trainers, and clubs for training opportunities.

---

## Current State Analysis

| Feature | Status | Notes |
|---------|--------|-------|
| Cycle Registrations | Built | Full registration system with intake requests, shown on academy/trainer/location pages |
| Direct Calendar Booking | Built | Players can book open slots, pay via Mollie or manual invoicing |
| General Waiting List | Not Built | No way for players to express interest when no availability exists |

---

## Overview of Three Booking Pathways

```text
+-------------------------------------------------------------------+
|                     PLAYER WANTS TO TRAIN                         |
+-------------------------------------------------------------------+
                              |
        +---------------------+---------------------+
        |                     |                     |
        v                     v                     v
+---------------+    +------------------+    +------------------+
|   SCENARIO 1  |    |    SCENARIO 2    |    |    SCENARIO 3    |
| No Open Spots |    | Open Registr.    |    | Open Calendar    |
|               |    | (Cycles)         |    | Slots            |
+---------------+    +------------------+    +------------------+
        |                     |                     |
        v                     v                     v
+---------------+    +------------------+    +------------------+
| Join Waiting  |    | Apply for Cycle  |    | Book & Pay       |
| List          |    | (No payment yet) |    | Directly         |
+---------------+    +------------------+    +------------------+
        |                     |                     |
        v                     v                     v
+---------------+    +------------------+    +------------------+
| Trainer/Acad. |    | Get Proposal     |    | Confirmed        |
| Reviews List  |    | & Confirm Spot   |    | Booking          |
+---------------+    +------------------+    +------------------+
```

---

## Implementation Plan

### Scenario 1: Waiting List (NEW)

Create a new waiting list system for players to express interest when no availability exists.

#### Database Changes

New table: `waiting_list_entries`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| owner_type | text | 'academy', 'trainer', or 'location' |
| owner_id | uuid | ID of academy/trainer/location |
| player_id | uuid | FK to profiles |
| lesson_type | text | 'private', 'duo', 'group', 'kids' |
| has_group | boolean | Whether player has training partners |
| group_size | integer | Number of people if has_group is true |
| rating | decimal | Player's skill level |
| rating_system | text | Rating system code (e.g., 'knltb') |
| preferred_days | text[] | Days they're available |
| preferred_time_windows | jsonb | Granular availability (same format as intake_requests) |
| notes | text | Additional notes |
| status | text | 'active', 'contacted', 'archived' |
| contacted_at | timestamptz | When trainer/academy reached out |
| created_at | timestamptz | When they joined the list |

RLS Policies:
- Players can insert/view their own entries
- Trainers/academies can view entries for their profiles
- Trainers/academies can update status of entries for their profiles

#### New UI Components

1. **WaitingListForm** - Form for players to express interest
   - Lesson type selection (private/duo/group/kids)
   - "Do you have training partners?" toggle
   - Group size selector (if has partners)
   - Rating input with system selector
   - Day/time availability picker (reuse DayAvailabilityPicker)
   - Notes textarea
   - Consent checkbox

2. **WaitingListCard** - Display on profile pages when no open availability
   - Shows for academy, trainer, and location profiles
   - Appears when no cycles are open AND no open calendar slots
   - CTA: "Join Waiting List" / "Zet jezelf op de wachtlijst"

3. **MyWaitingListEntries** - Player dashboard section
   - Shows all waiting list entries for the player
   - Status indicator (active, contacted)
   - Option to remove themselves from list

4. **WaitingListManagement** - Academy/Trainer dashboard
   - Table of waiting list entries
   - Filter by status, lesson type
   - Actions: Mark as contacted, Archive, Create slot for player

#### Files to Create

| File | Purpose |
|------|---------|
| src/lib/waitingList.ts | CRUD functions for waiting list |
| src/components/waitingList/WaitingListForm.tsx | Form component |
| src/components/waitingList/WaitingListCard.tsx | Profile page card |
| src/components/waitingList/WaitingListTable.tsx | Admin table |
| src/i18n/locales/en/waitingList.json | English translations |
| src/i18n/locales/nl/waitingList.json | Dutch translations |

#### Files to Modify

| File | Changes |
|------|---------|
| AcademyPublicProfile.tsx | Add WaitingListCard when no cycles/slots |
| TrainerProfile.tsx | Add WaitingListCard when no cycles/slots |
| LocationDetail.tsx | Add WaitingListCard when no cycles/slots |
| PlayerDashboard.tsx | Add MyWaitingListEntries section |
| TrainerDashboard.tsx | Add link to waiting list management |
| AcademyDashboard.tsx | Add link to waiting list management |

---

### Scenario 2: Open Registrations (VERIFY & ENHANCE)

The cycle registration system is already built. Verify it's displayed consistently across all profile types.

#### Current Coverage

| Page | Component Used | Status |
|------|----------------|--------|
| Academy Profile | AcademyOpenCycles | Working |
| Trainer Profile | TrainerOpenCycles | Working |
| Location/Club Profile | LocationOpenCycles | Working |

#### Enhancements Needed

- Ensure consistent empty state messaging across all three components
- Add "No spots guaranteed" messaging to clarify expectations

---

### Scenario 3: Open Calendar Slots (VERIFY & ENHANCE)

Direct booking of calendar slots is already built via BookLesson.tsx.

#### Current Flow

1. Player visits trainer profile
2. Clicks "Book Lesson" button
3. Sees available individual slots and full cyclus bundles
4. Selects slot/cyclus
5. Either:
   - Pays via Mollie (if enabled)
   - Confirms with manual invoicing
   - Submits request (if approval required)

#### Visibility Enhancements Needed

Show upcoming available slots directly on profile pages:
- Add "Upcoming Availability" preview card to TrainerProfile.tsx
- Show next 3-5 available slots with "View All" link to BookLesson page

---

## Translation Keys

### English (waitingList.json)

```text
{
  "title": "Waiting List",
  "joinWaitingList": "Join Waiting List",
  "noSpotsAvailable": "No training spots available right now",
  "getNotified": "Join the waiting list and we'll notify you when a spot opens up.",
  "form": {
    "lessonType": "What type of training are you looking for?",
    "hasGroup": "Do you already have training partners?",
    "groupSize": "How many people in your group?",
    "rating": "Your skill level",
    "availability": "When are you available?",
    "notes": "Anything else we should know?",
    "submit": "Add to Waiting List"
  },
  "success": {
    "title": "You're on the list!",
    "message": "We'll reach out when a spot becomes available."
  },
  "myEntries": {
    "title": "My Waiting List",
    "active": "Active",
    "contacted": "Contacted",
    "remove": "Remove"
  }
}
```

---

## Implementation Phases

### Phase 1: Database & Core Logic
- Create waiting_list_entries table with RLS
- Implement src/lib/waitingList.ts with CRUD operations
- Add translation files

### Phase 2: Player-Facing UI
- Build WaitingListForm component
- Build WaitingListCard component
- Integrate into academy/trainer/location profiles
- Add player dashboard section

### Phase 3: Management UI
- Build WaitingListTable for trainers/academies
- Add management actions (contact, archive)
- Add to trainer and academy dashboards

### Phase 4: Notifications (Future)
- Email when contacted
- Email when spot opens (automated matching)

---

## Technical Notes

- Reuse DayAvailabilityPicker component from cycles for time preferences
- Follow existing patterns from intake_requests for data structure
- Use same status badge styling patterns as IntakeRequestsTable
- Waiting list is owner-agnostic (works for academies, trainers, and locations)
