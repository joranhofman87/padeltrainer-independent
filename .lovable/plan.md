

# Club Dashboard: Add Sidebar Navigation and Fix Routes

## Overview
Replace the current horizontal dropdown navigation bar in the Club dashboard with a sidebar-based layout, matching the Trainer and Academy dashboards. Also fix all navigation paths missing the `/app/` prefix.

## Changes

### 1. Create `ClubSidebar.tsx` (new file)
Create a new sidebar component following the exact same pattern as `AcademySidebar.tsx`:
- **Header**: Club logo/icon, club name, verified badge, collapse toggle
- **Navigation sections**:
  - Dashboard (standalone)
  - People group (collapsible): Trainers, Players
  - Schedule group (collapsible): Calendar, Lessons
  - Tournaments (standalone)
  - Business group (collapsible): Profile, Subscription, Settings
- **Footer**: ProfileSwitcher, View Public Profile button, ThemeToggle, LanguageSwitcher, Logout
- All paths use `/app/club/...` prefix

### 2. Rewrite `ClubLayout.tsx`
Replace the current header + horizontal nav layout with the sidebar pattern from `AcademyLayout.tsx`:
- Wrap content in `SidebarProvider` with `ClubSidebar` + `SidebarInset`
- Remove the top header bar and club info section (moved into sidebar header)
- Add mobile header with `SidebarTrigger`
- Fix `isOnSubscriptionPage` check: `/club/subscription` --> `/app/club/subscription`
- Fix `subscriptionPath` in `SubscriptionOverlay`: `/club/subscription` --> `/app/club/subscription`

### 3. Delete `ClubNavigation.tsx`
No longer needed since the sidebar replaces it entirely.

### 4. Fix remaining broken paths
- `ClubLayout.tsx` line 143: `isOnSubscriptionPage` uses `/club/subscription` instead of `/app/club/subscription`
- `ClubLayout.tsx` line 304: `SubscriptionOverlay` `subscriptionPath` uses `/club/subscription`
- `AcademyLayout.tsx` line 133: `isOnSubscriptionPage` uses `/academy/subscription` instead of `/app/academy/subscription`
- `AcademyLayout.tsx` line 165: navigate uses `/academy/onboarding` instead of `/app/onboarding/academy`
- `AcademyLayout.tsx` line 222: `SubscriptionOverlay` `subscriptionPath` uses `/academy/subscription`

## Technical Details

### Sidebar structure (mirrors AcademySidebar)
```text
+---------------------------+
| Logo                      |
| Club Name     [collapse]  |
| Verified Badge            |
+---------------------------+
| Dashboard                 |
| People >                  |
|   Trainers                |
|   Players                 |
| Schedule >                |
|   Calendar                |
|   Lessons                 |
| Tournaments               |
| Business >                |
|   Profile                 |
|   Subscription            |
|   Settings                |
+---------------------------+
| ProfileSwitcher           |
| View Public Profile       |
| Theme | Lang | Logout     |
+---------------------------+
```

### Files modified
- **New**: `src/components/club/ClubSidebar.tsx`
- **Rewritten**: `src/components/club/ClubLayout.tsx`
- **Deleted**: `src/components/club/ClubNavigation.tsx`
- **Fixed**: `src/components/academy/AcademyLayout.tsx` (path fixes)

