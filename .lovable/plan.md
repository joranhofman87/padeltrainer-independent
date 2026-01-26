

# Consistent Trainer Navigation - Implementation Plan

## Overview
Add a secondary navigation bar to the Trainer pages, matching the style and structure of the existing Club navigation. This will improve navigation consistency across the platform and make it easier for trainers to access key features.

---

## Current State

### Club Layout
- Has a **top header** (logo, language switcher, profile switcher, settings, logout)
- Has a **secondary info section** (club name, location, verification badge, view public profile button)
- Has a **navigation bar** (`ClubNavigation` component) with:
  - Dashboard (standalone)
  - People dropdown (Trainers, Players)
  - Schedule dropdown (Calendar, Lessons)
  - Registration dropdown (Cycles, Intake Requests)
  - Club dropdown (Profile, Subscription, Settings)
  - Tournaments (standalone)

### Trainer Layout
- Has only a **top header** (logo, language switcher, profile switcher, settings, avatar, logout)
- **No secondary navigation bar** - users must navigate via the dashboard cards

---

## Implementation Plan

### 1. Create `TrainerNavigation` Component
Create a new component `src/components/trainer/TrainerNavigation.tsx` that mirrors `ClubNavigation`:

**Navigation Structure:**
- **Dashboard** (standalone) → `/trainer`
- **Schedule** dropdown:
  - Calendar → `/trainer/calendar`
  - Open Slots → `/trainer/open-slots`
- **Players** dropdown:
  - My Players → `/trainer/players`
  - Intake Requests → `/trainer/intake-requests`
- **Registration** dropdown:
  - Cycles → `/trainer/cycles`
  - Cyclus Builder → `/trainer/cyclus`
- **Business** dropdown:
  - Earnings → `/earnings`
  - Subscription → `/subscription`
  - Analytics → `/analytics`
  - Settings → `/trainer/settings`

### 2. Update `TrainerLayout` Component
Modify `src/components/trainer/TrainerLayout.tsx` to add:
- A secondary section below the header (similar to club layout)
- Display trainer name and avatar
- "View Public Profile" button linking to the trainer's public profile
- Include the new `TrainerNavigation` component

### 3. Add Translation Keys
Add navigation translation keys to the trainer locale files:

**English (`src/i18n/locales/en/trainer.json`):**
```json
"nav": {
  "dashboard": "Dashboard",
  "schedule": "Schedule",
  "calendar": "Calendar",
  "openSlots": "Open Slots",
  "players": "Players",
  "myPlayers": "My Players",
  "intakeRequests": "Intake Requests",
  "registration": "Registration",
  "cycles": "Cycles",
  "cyclus": "Cyclus Builder",
  "business": "Business",
  "earnings": "Earnings",
  "subscription": "Subscription",
  "analytics": "Analytics",
  "settings": "Settings",
  "viewPublicProfile": "View Public Profile"
}
```

**Dutch (`src/i18n/locales/nl/trainer.json`):**
```json
"nav": {
  "dashboard": "Dashboard",
  "schedule": "Rooster",
  "calendar": "Kalender",
  "openSlots": "Open Plekken",
  "players": "Spelers",
  "myPlayers": "Mijn Spelers",
  "intakeRequests": "Intake Aanvragen",
  "registration": "Registratie",
  "cycles": "Cycli",
  "cyclus": "Cyclus Bouwer",
  "business": "Bedrijf",
  "earnings": "Inkomsten",
  "subscription": "Abonnement",
  "analytics": "Statistieken",
  "settings": "Instellingen",
  "viewPublicProfile": "Bekijk Publiek Profiel"
}
```

---

## Technical Details

### Files to Create
1. `src/components/trainer/TrainerNavigation.tsx` - New navigation component

### Files to Modify
1. `src/components/trainer/TrainerLayout.tsx` - Add trainer info section and navigation
2. `src/i18n/locales/en/trainer.json` - Add nav translations
3. `src/i18n/locales/nl/trainer.json` - Add nav translations

### Component Structure
The `TrainerNavigation` component will follow the exact same pattern as `ClubNavigation`:
- Use `DropdownMenu` from Radix UI for grouped items
- Use `Button` with `variant="ghost"` or `variant="secondary"` for active state
- Icons from `lucide-react` matching each navigation item
- Proper `z-50` and `bg-popover` classes on dropdown content
- Horizontal scroll with `overflow-x-auto` for mobile

### Updated TrainerLayout Structure
```text
<div> (min-h-screen, gradient background)
  <header> (sticky top bar)
    - Logo
    - Language Switcher
    - Profile Switcher
    - Settings button
    - Logout button
  </header>
  
  <div> (trainer info section - NEW)
    - Avatar + Trainer Name
    - "Trainer" badge
    - View Public Profile button
    - <TrainerNavigation />
  </div>
  
  <Outlet /> (page content)
</div>
```

### Route Mapping
| Navigation Item | Route |
|----------------|-------|
| Dashboard | `/trainer` |
| Calendar | `/trainer/calendar` |
| Open Slots | `/trainer/open-slots` |
| My Players | `/trainer/players` |
| Intake Requests | `/trainer/intake-requests` |
| Cycles | `/trainer/cycles` |
| Cyclus Builder | `/trainer/cyclus` |
| Earnings | `/earnings` |
| Subscription | `/subscription` |
| Analytics | `/analytics` |
| Settings | `/trainer/settings` |

---

## Visual Consistency
- Same dropdown styling (`bg-popover z-50 min-w-[160px]`)
- Same button sizes (`size="sm"`)
- Same active state (`bg-secondary`)
- Same icon sizes (`h-4 w-4`)
- Same responsive behavior (icons only on mobile, labels on desktop)

