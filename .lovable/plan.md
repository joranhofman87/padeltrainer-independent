

# Fix: Academy Locations 404 Error

## Problem
The "Locaties" (Locations) link in the academy sidebar and dashboard navigates to `/academy/locations`, but the actual route is registered at `/app/academy/locations`. This causes a 404 because `/nl/academy/locations` doesn't match any route.

## Root Cause
Several navigation paths use the old `/academy/...` prefix instead of `/app/academy/...`:
- Academy sidebar: links to `/academy/locations`
- Academy dashboard: navigates to `/academy/locations` (both the stats card click and the "Locaties Beheren" button)

This is consistent with the single-domain routing architecture where all application routes must use the `/app/` prefix.

## Solution
Update all academy navigation paths to use the `/app/` prefix. Three files need changes:

### 1. `src/components/academy/AcademySidebar.tsx`
- Change `to="/academy/locations"` to `to="/app/academy/locations"`

### 2. `src/pages/academy/AcademyDashboard.tsx`
- Change `navigate('/academy/locations')` to `navigate('/app/academy/locations')` (two occurrences: stats card click and manage button)

### 3. `src/components/academy/AcademyNavigation.tsx`
- Change `path: "/academy/locations"` to `path: "/app/academy/locations"`

## Scope Check
While fixing this, all other academy navigation paths in these files should also be audited and updated to use `/app/academy/...` if they don't already, to prevent similar 404s on other pages.

