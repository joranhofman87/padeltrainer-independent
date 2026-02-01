
# Add Sidebar Navigation to Trainer Dashboard

## Overview
Replace the current horizontal dropdown navigation with a collapsible sidebar, following the AdminLayout pattern. The sidebar will provide better navigation UX with clear grouping, active state highlighting, and dynamic content like "My Clubs".

## Navigation Structure

```text
+----------------------------------+
| [Avatar] Trainer Name            |
| 🟠 Trainer Badge                 |
| [Collapse Toggle]                |
+----------------------------------+
| 📊 Dashboard                     |
+----------------------------------+
| 👥 Players ▼                     |
|   ├─ All Players                 |
|   └─ Intake Requests             |
+----------------------------------+
| 📅 Schedule ▼                    |
|   ├─ My Calendar                 |
|   └─ Open Slots                  |
+----------------------------------+
| 📋 Registration ▼                |
|   └─ Create Cyclus               |
+----------------------------------+
| 🏠 My Clubs ▼  (if has clubs)    |
|   ├─ Club Name 1                 |
|   ├─ Club Name 2                 |
|   └─ Club Name 3                 |
+----------------------------------+
| 💼 Business ▼                    |
|   ├─ Settings                    |
|   ├─ Subscription                |
|   └─ Earnings  (if independent)  |
+----------------------------------+
| [Theme] [View Profile] [Logout]  |
+----------------------------------+
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/components/trainer/TrainerSidebar.tsx` | Create | New sidebar component |
| `src/components/trainer/TrainerLayout.tsx` | Modify | Replace layout with SidebarProvider pattern |
| `src/lib/trainer.ts` | Create | Add `getTrainerClubs()` function |

## Technical Implementation

### 1. New File: `src/lib/trainer.ts`

Create a helper function to fetch clubs where the trainer is a `club_trainer`:

```typescript
export async function getTrainerClubs(trainerProfileId: string) {
  // Query trainer_locations with relationship_type = 'club_trainer'
  // Join to locations table
  // Join to club_profiles via location_id
  // Return array of { clubId, clubName, locationSlug }
}
```

### 2. New File: `src/components/trainer/TrainerSidebar.tsx`

Key features:
- Uses `useSidebar()` for collapsed state
- Fetches trainer's clubs dynamically using `getTrainerClubs()`
- Fetches trainer's academy using `getTrainerAcademy()` to conditionally hide Earnings
- Uses `Collapsible` components for expandable groups
- Uses `NavLink` with `activeClassName` for active route styling
- Auto-expands group containing active route
- Shows tooltips when collapsed
- Includes footer with theme toggle, view profile button, and logout

### 3. Modified: `src/components/trainer/TrainerLayout.tsx`

Replace current structure with:

```tsx
<SidebarProvider>
  <div className="flex min-h-screen w-full">
    <TrainerSidebar />
    <main className="flex-1 overflow-auto">
      {/* Mobile header */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background px-4 lg:hidden">
        <SidebarTrigger />
        <span className="font-semibold">Trainer Dashboard</span>
      </header>
      <div className="p-6">
        <Outlet />
      </div>
    </main>
  </div>
</SidebarProvider>
```

Remove:
- Current top header bar
- Trainer info section (moved to sidebar header)
- TrainerNavigation component (replaced by sidebar)

## Route Mappings

| Menu Item | Route | Icon |
|-----------|-------|------|
| Dashboard | `/trainer` | LayoutDashboard |
| All Players | `/trainer/players` | Users |
| Intake Requests | `/trainer/intake-requests` | FileText |
| My Calendar | `/trainer/calendar` | Calendar |
| Open Slots | `/trainer/open-slots` | Clock |
| Create Cyclus | `/trainer/cyclus` | CalendarDays |
| Settings | `/trainer/settings` | Settings |
| Subscription | `/subscription` | CreditCard |
| Earnings | `/earnings` | CreditCard |

Dynamic club links will point to the club's public page via `/location/{slug}`.

## Conditional Logic

| Condition | Effect |
|-----------|--------|
| `trainerClubs.length > 0` | Show "My Clubs" section |
| `trainerAcademy === null` | Show "Earnings" menu item |
| Route matches group item | Auto-expand that group |

## i18n Updates

Add new translation keys to `src/i18n/locales/en/trainer.json` and `nl/trainer.json`:

```json
{
  "nav": {
    "myClubs": "My Clubs",
    "allPlayers": "All Players",
    "createCyclus": "Create Cyclus"
  }
}
```

Note: Most keys already exist (dashboard, calendar, openSlots, settings, subscription, earnings, intakeRequests).

## Mobile Behavior

- Sidebar hidden by default on mobile (`lg:hidden`)
- `SidebarTrigger` button in mobile header opens sidebar as overlay/sheet
- Groups remain collapsible within mobile view

## Visual Consistency

- Uses same components as AdminSidebar: `Sidebar`, `SidebarContent`, `SidebarGroup`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `Collapsible`
- Trainer badge shown in sidebar header with orange accent
- Profile avatar displayed in collapsed and expanded states
