

# Remove Academy Earnings Page

## What changes
Drop the `AcademyEarnings` page entirely and remove all navigation references to it. The Mollie connection management already lives in Academy Settings.

## Changes

### 1. Delete file
- `src/pages/academy/AcademyEarnings.tsx`

### 2. Remove from navigation
- **`src/components/academy/AcademyNavigation.tsx`** — remove the `earnings` entry from `groupedItems`
- **`src/components/academy/AcademySidebar.tsx`** — remove the earnings nav link and its active-state checks

### 3. Remove route
- **`src/components/DomainRouter.tsx`** (or wherever academy routes are defined) — remove the `/app/academy/earnings` route

### 4. Update Mollie callback redirect
- **`src/pages/MollieCallback.tsx`** — change academy redirect from `/academy/earnings` to `/academy/settings` (with the `mollie_connected` param)

### 5. Update admin reference
- **`src/components/admin/MollieDisconnectSection.tsx`** — update help text from "earnings page" to "settings page"

