

# Reorder Trainer Profile: Prioritize Booking Sections

## Current Layout (Desktop — 2/3 grid)

**Main column:** Coaching Style → About → Academy → Locations → City link → Book CTA → Open Slots → Open Cycles → Waiting List → Reviews

**Sidebar:** Quick Stats → Contact → Specializations → Certifications → Social

## Problem
Available slots and booking CTAs are buried at the bottom. On mobile (single column, main then sidebar), they're even further down.

## Proposed New Layout

**Main column:**
1. Coaching Style
2. **Book CTA + Open Slots + Open Cycles** ← moved up from bottom
3. Waiting List
4. Academy
5. Locations → City link
6. Reviews

**Sidebar:**
1. Quick Stats
2. Contact
3. **About** ← moved from main
4. Specializations
5. Certifications
6. Social

**Mobile consideration:** Since `ProfileContentGrid` uses `lg:grid-cols-3` (single column below `lg`), main content renders first. Slots at position 2 in main means they'll be the second thing users see on mobile — right after coaching style. This is ideal.

## Changes

### `src/pages/TrainerProfile.tsx`
- Move the About card (`profile.bio`) from main column into sidebar (after Contact, before Specializations)
- Move Book CTA card, `TrainerOpenSlots`, `TrainerOpenCycles` up to directly after the Coaching Style card
- Keep Waiting List right after the booking sections
- Academy, Locations, City link shift down

### Files
- `src/pages/TrainerProfile.tsx` — Reorder sections only, no new components

