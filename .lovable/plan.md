

# Add Trainers Section to Academy Dashboard

## What
Add a trainers overview section at the bottom of the Academy Dashboard page (`/app/academy`), beneath the existing activity grid (Recent Players, Recent Bookings, Registrations, Upcoming Open Spots).

## Changes

### 1. Update `src/pages/academy/AcademyDashboard.tsx`

- Import `getAcademyTrainersWithProfiles` (already have `getAcademyTrainers` imported for stats)
- Import `Avatar`, `AvatarFallback`, `AvatarImage` for trainer display
- Add a new `useQuery` to fetch trainers with profiles (reuse existing `getAcademyTrainersWithProfiles`)
- Render a "Trainers" section after the activity grid with:
  - Section header with title + "View all" button linking to `/app/academy/trainers`
  - Grid of trainer cards (compact style matching the design system) showing:
    - Avatar + name
    - Specializations as badges
    - Hourly rate and experience years
    - Visibility status (visible/hidden badge)
    - Link to trainer profile

### 2. Layout
- Full-width section below the 2-column activity grid
- Trainer cards in a responsive 3-column grid (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`)
- Show max 6 trainers on the dashboard; "View all" navigates to full trainers page

