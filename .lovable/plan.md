

# Trainer & Academy Registration and Booking System - UX Improvement Plan

## Executive Summary

After thorough exploration, I've identified that the core functionality exists but the UX is fragmented and lacks a clear "command center" for academies to manage registrations across multiple clubs. The main issues are:

1. **Registrations (Cycles) lack club/location context** - Cycles are owned by academies or trainers but don't explicitly connect to specific clubs/locations with their varying configurations
2. **No central registration overview** - Academies need a table/dashboard view to see all cycles across clubs at a glance
3. **Calendar and open slots are disconnected from registrations** - Players booking individual slots vs. registering for cycles are separate flows
4. **Follow/waitlist features exist but aren't prominently surfaced** when slots are unavailable

---

## Current State Analysis

### What's Working Well

- **Cycles (Registrations)** exist at `/academy/cycles` with create/edit/delete functionality
- **Cycle Application Form** allows players to apply with availability preferences
- **LocationOpenCycles** component displays cycles from trainers/academies at a club location
- **Open Slots booking** via `/trainer/open-slots` and `/book/:trainerId`
- **Follow button** exists on trainer profiles for notifications
- **Intake Requests Table** shows applications with proposal generation

### Key Gaps Identified

| Gap | Current State | Impact |
|-----|---------------|--------|
| No location/club linkage on cycles | Cycles have `owner_type`/`owner_id` but no explicit `location_id` | Academies can't create cycles "for Club X" with club-specific pricing |
| No registrations dashboard table | Grid of cards view only | Hard to get quick overview, duplicate, compare |
| No pricing per cycle | Only trainer hourly rate exists | Can't set different prices per club (indoor vs outdoor, etc.) |
| Calendar slots disconnected | Slots and cycles are separate systems | Confusing which to use when |
| Waitlist not implemented | Only "follow" for trainers exists | No waitlist for specific cycles/slots |

---

## Proposed Solution

### Phase 1: Enhanced Registration (Cycles) Management for Academies

**Goal:** Create a clear, table-based "Registrations" dashboard where academies can:
- See all registrations at a glance with status, dates, club, applications count
- Filter by club/location, status, date range
- Duplicate cycles with one click
- Quickly toggle open/closed status
- See pricing information per cycle

**Changes Required:**

1. **Database: Add fields to `cycles` table**
   - `location_id` (UUID, nullable, FK to locations) - which club this cycle is for
   - `price_per_session` (numeric, nullable) - session price for this cycle
   - `total_price` (numeric, nullable) - or fixed package price
   - `currency` (text, default 'EUR')

2. **New: Registrations Table View Component**
   - Replace card grid with sortable/filterable table
   - Columns: Name, Club, Dates, Duration (weeks), Status, Applications, Price, Actions
   - Quick actions: Open/Close, Duplicate, Edit, View Applications, Copy Link

3. **Enhanced CycleForm**
   - Add location picker (from `academy_locations`)
   - Add pricing fields
   - Add "duplicate from existing" option

4. **Academy Sidebar Navigation Update**
   - Rename "Cycles" to "Registrations" for clarity
   - Add badge with open registration count

### Phase 2: Unified Calendar Experience

**Goal:** Help trainers understand the relationship between their calendar slots and registration cycles.

**Changes Required:**

1. **Dashboard Clarity**
   - Add "Filling Methods" info card explaining:
     - Registrations (cycles) - for recurring programs
     - Open Slots - for one-off bookings
   - Visual distinction on calendar for cycle-linked vs individual slots

2. **Cycle Slot Generation**
   - When creating a cycle, optionally auto-generate availability slots
   - Link slots to cycle via `cyclus_id` (already exists)

3. **Calendar Legend/Filter**
   - Filter to show: All | Cycle Slots | Individual Slots | Booked | Available

### Phase 3: Waitlist & Follow Improvements

**Goal:** When nothing is available, give players clear actions.

**Changes Required:**

1. **Database: Add `waitlists` table**
   - `id`, `user_id`, `type` (cycle|trainer|location), `target_id`, `created_at`
   - Notify via email when spots open

2. **UI Enhancements**
   - On trainer profile when no slots: "Join Waitlist" or "Follow for Updates"
   - On cycle card when deadline passed: "Notify me for next cycle"
   - On location page: "Follow this club" button

3. **Notification System**
   - Trigger `notify-followers` edge function when:
     - New cycle opens
     - Slot becomes available
     - New trainer joins location

---

## Technical Implementation Details

### Database Migration

```sql
-- Add location and pricing to cycles
ALTER TABLE cycles
ADD COLUMN location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
ADD COLUMN price_per_session NUMERIC(10,2),
ADD COLUMN total_price NUMERIC(10,2),
ADD COLUMN currency TEXT DEFAULT 'EUR';

-- Create waitlists table
CREATE TABLE waitlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  waitlist_type TEXT NOT NULL CHECK (waitlist_type IN ('cycle', 'trainer', 'location')),
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  UNIQUE(user_id, waitlist_type, target_id)
);

-- RLS for waitlists
ALTER TABLE waitlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own waitlist entries"
ON waitlists FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Academy/trainer owners can view waitlist for their cycles"
ON waitlists FOR SELECT USING (
  waitlist_type = 'cycle' AND
  EXISTS (
    SELECT 1 FROM cycles c
    WHERE c.id = target_id
    AND (
      (c.owner_type = 'academy' AND is_academy_manager(auth.uid(), c.owner_id))
      OR
      (c.owner_type = 'trainer' AND EXISTS (
        SELECT 1 FROM trainer_profiles tp WHERE tp.id = c.owner_id AND tp.user_id = auth.uid()
      ))
    )
  )
);
```

### New/Modified Files

| File | Change Type | Description |
|------|-------------|-------------|
| `src/pages/academy/AcademyCycles.tsx` | Modify | Replace card grid with table, add filters |
| `src/components/cycles/CyclesTable.tsx` | New | Table component with sorting, filtering |
| `src/components/cycles/CycleForm.tsx` | Modify | Add location picker, pricing fields |
| `src/lib/cycles.ts` | Modify | Add pricing, location to types and queries |
| `src/components/academy/AcademySidebar.tsx` | Modify | Rename nav, add badge |
| `src/components/waitlist/JoinWaitlistButton.tsx` | New | Reusable waitlist CTA |
| `src/hooks/useWaitlist.ts` | New | Waitlist state management |
| `supabase/functions/notify-waitlist/index.ts` | New | Email notifications when spots open |

### UI Mockup: Registrations Table

```text
+---------------------------------------------------------------------------------+
| Registrations                                               [+ New Registration] |
+---------------------------------------------------------------------------------+
| Filter: [All Clubs ▼] [All Status ▼] [2026 ▼]                      🔍 Search    |
+---------------------------------------------------------------------------------+
| Name           | Club          | Period      | Status | Apps | Price   | Actions |
+----------------+---------------+-------------+--------+------+---------+---------+
| Spring 2026    | PAZ Zeist     | Feb-Apr     | Open   | 12   | €450    | ⋮       |
| Spring 2026    | TC Boemerang  | Feb-Apr     | Draft  | 0    | €380    | ⋮       |
| Winter 2025    | PAZ Zeist     | Oct-Dec     | Closed | 28   | €420    | ⋮       |
+---------------------------------------------------------------------------------+
```

---

## Recommended Implementation Order

1. **Database changes** - Add location_id and pricing to cycles
2. **Update CycleForm** - Location picker, pricing fields
3. **Create CyclesTable** - Replace cards with table view
4. **Update AcademyCycles page** - Integrate table, add filters
5. **Add waitlist table** - Database + RLS
6. **Waitlist UI components** - JoinWaitlistButton, hooks
7. **Notification edge function** - notify-waitlist
8. **Calendar improvements** - Legends, filters, slot type indicators

---

## Benefits

- **For Academies:** Central command center to manage all registrations across clubs
- **For Trainers:** Clearer understanding of how slots and cycles work together  
- **For Players:** Always have an action (apply, book, follow, waitlist) rather than dead ends
- **For Business:** Better conversion as interested players can always express intent

