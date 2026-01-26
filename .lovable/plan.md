

# Consistent Player Navigation - Implementation Plan

## Overview
Add a persistent navigation layout to the Player pages, matching the style and structure of the existing Club and Trainer navigation. This will complete the navigation consistency across all three user roles in the application.

---

## Current State

### Club Layout (Reference)
- Has a **top header** (logo, language switcher, profile switcher, settings, logout)
- Has a **secondary info section** (club name, location, verification badge, view public profile button)
- Has a **navigation bar** (`ClubNavigation` component) with dropdown menus
- Uses `<Outlet />` for nested route content

### Trainer Layout (Recently Added)
- Has a **top header** (logo, language switcher, profile switcher, settings, logout)
- Has a **secondary info section** (avatar, name, badge, view public profile button)
- Has a **navigation bar** (`TrainerNavigation` component) with dropdown menus
- Uses `<Outlet />` for nested route content

### Player Layout (Current State - MISSING)
- **No persistent layout** - each player page has its own header
- **No secondary navigation bar** - users navigate via dashboard cards or back buttons
- Routes are scattered, not nested under a common layout

---

## Implementation Plan

### 1. Create `PlayerLayout` Component
Create a new component `src/components/player/PlayerLayout.tsx` that mirrors the Club/Trainer layouts:

**Structure:**
- Top header with logo, language switcher, profile switcher, logout
- Secondary section with player avatar, name, "Player" badge
- `PlayerNavigation` component
- `<Outlet />` for page content
- Blue gradient background (matching current player dashboard theme)

### 2. Create `PlayerNavigation` Component
Create a new component `src/components/player/PlayerNavigation.tsx`:

**Navigation Structure:**
- **Dashboard** (standalone) - `/player`
- **Bookings** (standalone) - `/player/bookings`
- **Following** (standalone) - `/player/following`
- **Account** dropdown:
  - Edit Profile - `/player/profile`
  - Notifications - `/player/settings/notifications`
  - Calendar Sync - `/player/settings/calendar`

### 3. Update Route Configuration
Modify `src/App.tsx` to:
- Wrap player routes under a new `PlayerLayout` component
- Reorganize routes to use consistent `/player/*` paths:
  - `/player` - Dashboard
  - `/player/bookings` - Bookings (moved from `/bookings`)
  - `/player/following` - Following (already exists)
  - `/player/profile` - Edit Profile (moved from `/profile/edit`)
  - `/player/settings/notifications` - Notifications (moved from `/settings/notifications`)
  - `/player/settings/calendar` - Calendar Sync (moved from `/settings/calendar`)

### 4. Update Player Pages
Simplify player pages to remove duplicate headers since the layout will provide them:
- `PlayerDashboard.tsx` - Remove header, keep content only
- `PlayerBookings.tsx` - Remove header, keep content only
- `FollowingList.tsx` - Remove header, keep content only
- `EditProfile.tsx` - Remove header, keep content only (for player role)
- `NotificationSettings.tsx` - Remove header, keep content only
- `CalendarSettings.tsx` - Remove header, keep content only

### 5. Add Translation Keys
Add navigation translation keys to the player locale files:

**English (`src/i18n/locales/en/player.json`):**
```json
"nav": {
  "dashboard": "Dashboard",
  "bookings": "Bookings",
  "following": "Following",
  "account": "Account",
  "editProfile": "Edit Profile",
  "notifications": "Notifications",
  "calendarSync": "Calendar Sync"
},
"badge": "Player"
```

**Dutch (`src/i18n/locales/nl/player.json`):**
```json
"nav": {
  "dashboard": "Dashboard",
  "bookings": "Boekingen",
  "following": "Volgend",
  "account": "Account",
  "editProfile": "Profiel Bewerken",
  "notifications": "Meldingen",
  "calendarSync": "Kalender Sync"
},
"badge": "Speler"
```

---

## Technical Details

### Files to Create
1. `src/components/player/PlayerLayout.tsx` - New layout component with persistent header and navigation
2. `src/components/player/PlayerNavigation.tsx` - New navigation component

### Files to Modify
1. `src/App.tsx` - Restructure player routes to be nested under PlayerLayout
2. `src/pages/PlayerDashboard.tsx` - Remove duplicate header, keep dashboard content
3. `src/pages/PlayerBookings.tsx` - Remove duplicate header, keep bookings content
4. `src/pages/FollowingList.tsx` - Remove duplicate header, keep following content
5. `src/pages/EditProfile.tsx` - Conditional header removal for player role
6. `src/pages/NotificationSettings.tsx` - Remove duplicate header, keep settings content
7. `src/pages/CalendarSettings.tsx` - Remove duplicate header, keep settings content
8. `src/i18n/locales/en/player.json` - Add nav translations
9. `src/i18n/locales/nl/player.json` - Add nav translations

### Route Migration

| Old Route | New Route |
|-----------|-----------|
| `/player` | `/player` (index) |
| `/bookings` | `/player/bookings` |
| `/player/following` | `/player/following` |
| `/profile/edit` | `/player/profile` |
| `/settings/notifications` | `/player/settings/notifications` |
| `/settings/calendar` | `/player/settings/calendar` |

### Visual Consistency
- Blue gradient background (`from-blue-50 via-background to-blue-100/30`)
- Same dropdown styling as Club/Trainer (`bg-popover z-50 min-w-[160px]`)
- Same button sizes (`size="sm"`)
- Same active state highlighting (`bg-secondary`)
- Same icon sizes (`h-4 w-4`)
- Same responsive behavior (icons only on mobile, labels on desktop)

### PlayerLayout Structure
```text
<div> (min-h-screen, blue gradient background)
  <header> (sticky top bar)
    - Logo (clickable to /player)
    - Language Switcher
    - Profile Switcher (context="player")
    - Logout button
  </header>
  
  <div> (player info section)
    - Avatar + Player Name
    - "Player" badge
    - <PlayerNavigation />
  </div>
  
  <Outlet /> (page content)
</div>
```

### Auth Guard
The `PlayerLayout` component will include the same auth guard logic currently in `PlayerDashboard`:
- Redirect to `/auth` if not logged in
- Redirect to `/select-role` if no role selected
- Redirect to `/trainer` if user is a trainer (not a player)

---

## Benefits
1. **Consistency**: All three user roles (Player, Trainer, Club) now have the same navigation pattern
2. **Easier Navigation**: Players can quickly access any feature from the persistent nav bar
3. **Reduced Code Duplication**: Header and auth guard logic centralized in one layout component
4. **Better UX**: No more "back" buttons needed - persistent navigation always visible
5. **Mobile Friendly**: Same responsive dropdown pattern as other layouts

