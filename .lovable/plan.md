

# Convert Player Dashboard to Sidebar Navigation

## Overview

Replace the player's top navigation bar layout with a sidebar layout matching the Trainer and Academy dashboards.

## Changes

### 1. New File: `src/components/player/PlayerSidebar.tsx`

Create a sidebar component following the exact same pattern as `TrainerSidebar.tsx` and `AcademySidebar.tsx`:

- **Header**: Avatar + player name + "Player" badge + collapse toggle
- **Nav items**:
  - Dashboard (`/player`) - standalone
  - Bookings (`/player/bookings`) - standalone
  - Following (`/player/following`) - standalone
  - Account group (collapsible):
    - Settings (`/player/settings`)
    - Notifications (`/player/settings/notifications`)
    - Calendar Sync (`/player/settings/calendar`)
- **Footer**: ProfileSwitcher, ThemeToggle, LanguageSwitcher, Logout button

Uses the same Sidebar UI primitives (`Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarMenu`, `SidebarMenuButton`, `NavLink`, `Collapsible`, etc.).

### 2. Rewrite: `src/components/player/PlayerLayout.tsx`

Replace the current top-header + info-bar + `PlayerNavigation` layout with:

```text
<SidebarProvider>
  <div className="flex min-h-screen w-full bg-gradient-to-br ...">
    <PlayerSidebar />
    <main className="flex-1 overflow-auto">
      <!-- Mobile header with SidebarTrigger (lg:hidden) -->
      <div className="p-4 md:p-6">
        <Outlet />
      </div>
    </main>
  </div>
</SidebarProvider>
```

This mirrors `TrainerLayout.tsx` exactly.

### 3. Delete: `src/components/player/PlayerNavigation.tsx`

No longer needed -- all navigation moves to the sidebar.

## Technical Details

- Reuses all existing Shadcn sidebar primitives (`Sidebar`, `SidebarProvider`, `SidebarTrigger`, `useSidebar`, etc.)
- Reuses `NavLink` component for active-state highlighting
- Reuses `ProfileSwitcher`, `LanguageSwitcher`, `ThemeToggle`
- Auth guard logic stays in `PlayerLayout.tsx`
- Player gradient background preserved (`from-blue-50` instead of Trainer's `from-orange-50`)
- Blue badge color preserved for player role distinction
- No translation key changes needed -- existing `player.nav.*` keys cover everything
