
# Plan: Admin Panel Sidebar Navigation Redesign

## Overview

Transform the admin panel from a card-based navigation on the dashboard to a modern sidebar-driven layout with consistent page structure across all admin pages. This will declutter the interface, improve navigation, and move the "Scrape Academies" action to the Academies page where it belongs.

## Current State Analysis

### Problems Identified
1. Dashboard is cluttered with 8 navigation cards + scrape action + stats + charts + fee structure
2. Each admin sub-page has its own header with back button - inconsistent navigation
3. No persistent navigation between admin sections
4. "Scrape Academies" is on the dashboard instead of the Academies page
5. Each page has slightly different filter/table layouts

### Current Admin Routes
- `/admin` - Dashboard (stats, charts, navigation cards)
- `/admin/users` - User management
- `/admin/trainers` - Trainer management
- `/admin/clubs` - Club management
- `/admin/academies` - Academy management
- `/admin/locations` - Location management
- `/admin/certifications` - Certifications and specializations
- `/admin/club-claims` - Pending club claims
- `/admin/rating-systems` - Rating systems
- `/admin/pricing` - Pricing plans

## Proposed Architecture

### New Component Structure

```text
AdminLayout (new)
├── Sidebar (left)
│   ├── Logo + Brand
│   ├── SidebarMenu
│   │   ├── Dashboard (with metrics icon)
│   │   ├── Users
│   │   ├── Trainers
│   │   ├── Clubs
│   │   ├── Club Claims (with badge for pending)
│   │   ├── Academies
│   │   ├── Locations
│   │   └── Certifications
│   └── Footer (theme toggle, logout)
└── Main Content Area (Outlet)
    └── Page-specific content (no individual headers)
```

### Sidebar Navigation Items

| Item | Icon | Route | Badge |
|------|------|-------|-------|
| Dashboard | LayoutDashboard | /admin | - |
| Users | Users | /admin/users | - |
| Trainers | GraduationCap | /admin/trainers | - |
| Clubs | Building2 | /admin/clubs | - |
| Club Claims | FileCheck | /admin/club-claims | pending count |
| Academies | School | /admin/academies | - |
| Locations | MapPin | /admin/locations | - |
| Certifications | Award | /admin/certifications | - |

Note: Rating Systems and Pricing are less frequently used - they will be accessible via a "Settings" dropdown or secondary menu section.

## Implementation Details

### Phase 1: Create AdminLayout Component

**File:** `src/components/admin/AdminLayout.tsx`

```typescript
// Uses SidebarProvider, Sidebar, SidebarContent from shadcn
// Includes:
// - Collapsible sidebar with icons in collapsed state
// - Active route highlighting using NavLink
// - Pending claims badge fetched via usePendingClaimsCount
// - Theme toggle + logout in sidebar footer
// - SidebarTrigger in mobile header
```

Key features:
- Sidebar collapsible (icon mode on desktop, sheet on mobile)
- Persists collapsed state in localStorage
- Active route highlighting
- Badge for pending club claims

### Phase 2: Update App Routing

Wrap all `/admin/*` routes under the new `AdminLayout`:

```tsx
<Route path="/admin" element={<AdminLayout />}>
  <Route index element={<AdminDashboard />} />
  <Route path="users" element={<AdminUsers />} />
  <Route path="trainers" element={<AdminTrainers />} />
  <Route path="clubs" element={<AdminClubs />} />
  <Route path="academies" element={<AdminAcademies />} />
  <Route path="locations" element={<AdminLocations />} />
  <Route path="certifications" element={<AdminCertifications />} />
  <Route path="club-claims" element={<AdminClubClaims />} />
  <Route path="rating-systems" element={<AdminRatingSystems />} />
  <Route path="pricing" element={<AdminPricing />} />
</Route>
```

### Phase 3: Simplify AdminDashboard

Remove from dashboard:
- All navigation cards (now in sidebar)
- Scrape Academies action (move to Academies page)

Keep on dashboard:
- Stats cards (AdminStatsCards)
- Charts (AdminCharts)
- Fee structure info card

New dashboard layout:
```text
┌─────────────────────────────────────┐
│ Platform Overview (title only)      │
├─────────────────────────────────────┤
│ Stats Cards (row)                   │
├─────────────────────────────────────┤
│ Charts Grid (2 columns)             │
├─────────────────────────────────────┤
│ Fee Structure Card                  │
└─────────────────────────────────────┘
```

### Phase 4: Standardize Sub-Pages

Remove from each admin page:
- Individual header with back button
- Duplicate access control logic (handled by AdminLayout)

Standardize page structure:
```text
┌─────────────────────────────────────┐
│ Page Title + Description + Actions  │
├─────────────────────────────────────┤
│ Filter Row (search + dropdowns)     │
├─────────────────────────────────────┤
│ Data Table                          │
├─────────────────────────────────────┤
│ Footer (showing X of Y)             │
└─────────────────────────────────────┘
```

### Phase 5: Move Scrape Academies to Academies Page

Add to `AdminAcademies.tsx`:
- "Scrape from PadelGids" button in the header actions area
- Progress indicator and toast notifications
- Same logic currently in AdminDashboard

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/components/admin/AdminLayout.tsx` | Create | New layout with sidebar |
| `src/components/admin/AdminSidebar.tsx` | Create | Sidebar navigation component |
| `src/App.tsx` | Modify | Nest admin routes under AdminLayout |
| `src/pages/AdminDashboard.tsx` | Modify | Remove nav cards, keep stats/charts |
| `src/pages/admin/AdminAcademies.tsx` | Modify | Add scrape action, remove header |
| `src/pages/admin/AdminUsers.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminTrainers.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminClubs.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminLocations.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminCertifications.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminClubClaims.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminRatingSystems.tsx` | Modify | Remove header, standardize layout |
| `src/pages/admin/AdminPricing.tsx` | Modify | Remove header, standardize layout |

## Standardized Page Template

Each admin page will follow this structure:

```tsx
export default function AdminXxx() {
  // Data fetching hooks
  // Filter state
  // Actions/handlers

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Page Title</h1>
          <p className="text-muted-foreground">Description text</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Action buttons */}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* Search + filter dropdowns */}
      </div>

      {/* Data Table */}
      <div className="rounded-md border">
        <Table>...</Table>
      </div>

      {/* Footer */}
      <p className="text-sm text-muted-foreground">
        Showing X of Y items
      </p>
    </div>
  );
}
```

## Technical Considerations

### Auth Guard
- AdminLayout will check `useIsAdmin()` and redirect non-admins
- Individual pages no longer need auth checks

### Sidebar State Persistence
- Collapsed state saved to localStorage
- Mobile uses Sheet drawer pattern (auto-handled by shadcn sidebar)

### Pending Claims Badge
- Sidebar fetches `usePendingClaimsCount()` hook
- Updates automatically when claims are processed

### Active Route
- Use `NavLink` component with `isActive` prop
- Highlight current section in sidebar

## Expected Result

Visual comparison:

**Before:**
- Cluttered dashboard with 8+ cards
- Each page has its own header/back button
- Inconsistent navigation patterns

**After:**
- Clean sidebar with 8 main navigation items
- Dashboard focuses on metrics/analytics
- All pages have consistent structure
- Scrape action logically placed on Academies page
- Better mobile experience with collapsible sidebar
