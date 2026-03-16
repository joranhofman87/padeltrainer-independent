

## Centered Hero Redesign — Full Implementation Plan

### Overview
Replace the current 2-column hero with a centered, SaaS-style layout featuring a large H1, subtitle, CTAs, and an interactive 4-tab product showcase with crossfading mock screens.

### Layout Structure

```text
┌────────────────────────────────────────────────┐
│                 (centered)                     │
│                                                │
│      Manage your padel coaching                │
│           like a pro.              ← big H1    │
│                                                │
│   One place to manage sessions, get paid,      │
│      and fill your schedule.       ← subtitle  │
│                                                │
│    [ Start free trial → ]  [ See how it works ]│
│                                                │
│  Free for players · No credit card required    │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ [Easy Booking] [Open Registration]       │  │
│  │ [Automated Payments] [Your Profile]      │  │
│  │                                          │  │
│  │  ┌────────────────────────────────────┐  │  │
│  │  │  Active mock screen (crossfade)    │  │  │
│  │  └────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

### Tab Order & Mock Screens

1. **Easy Booking** — Calendar view with available time slots + Google Calendar sync badge. Player picks a slot → "Book now" button. Shows the Google Calendar connection logo/icon to highlight the sync feature.

2. **Open Registration** — Player-facing sign-up form: name, email, level selector (Beginner/Intermediate/Advanced), "Register" button. Shows a confirmation checkmark animation-style state.

3. **Automated Payments** — Payment dashboard with recent transactions table (player name, amount, status badge: Paid/Pending). Mollie logo/badge shown to highlight the payment connection. Auto-invoice toggle switch.

4. **Your Profile** — Public trainer profile card: photo placeholder, name, rating stars, location, availability slots, "Book lesson" CTA. Badge showing "12 slots filled this month".

### Technical Implementation

**Mock screens**: All 4 rendered in DOM simultaneously, toggled via `opacity-0/opacity-100` + `transition-opacity duration-300` for instant crossfade. No animation library needed.

**Mobile**: Tabs use `overflow-x-auto` with `flex-nowrap` for horizontal scroll. Mock screens are responsive with reduced padding.

**Tab component**: Simple `useState` with index. Each tab is a button with active state (primary underline/pill highlight).

### Files to Modify

| File | Change |
|---|---|
| `src/components/home/HeroSection.tsx` | Full rewrite: centered layout, remove bullets, remove 2-col grid, add tab showcase component inline |
| `src/i18n/locales/en/marketing.json` | Update `homev2.hero` keys: new h1, subtitle, remove bullets, add tab labels + mock screen labels |
| `src/i18n/locales/nl/marketing.json` | Same translation updates in Dutch |
| `src/i18n/locales/es/marketing.json` | Same in Spanish |
| `src/i18n/locales/de/marketing.json` | Same in German |
| `src/i18n/locales/fr/marketing.json` | Same in French |

### Translation Keys to Add/Update

```json
{
  "homev2.hero.h1": "Manage your padel coaching like a pro.",
  "homev2.hero.subheadline": "One place to manage sessions, get paid, and fill your schedule.",
  "homev2.hero.tab_booking": "Easy Booking",
  "homev2.hero.tab_registration": "Open Registration",
  "homev2.hero.tab_payments": "Automated Payments",
  "homev2.hero.tab_profile": "Your Profile",
  "homev2.hero.mock_booking_slot": "Available",
  "homev2.hero.mock_booking_booked": "Booked",
  "homev2.hero.mock_booking_sync": "Synced with Google Calendar",
  "homev2.hero.mock_reg_title": "Join a training group",
  "homev2.hero.mock_reg_level": "Select your level",
  "homev2.hero.mock_reg_cta": "Register",
  "homev2.hero.mock_payments_title": "Recent payments",
  "homev2.hero.mock_payments_auto": "Auto-invoice",
  "homev2.hero.mock_payments_powered": "Powered by Mollie",
  "homev2.hero.mock_profile_slots": "{{count}} slots filled this month",
  "homev2.hero.mock_profile_cta": "Book lesson"
}
```

### What Gets Removed
- Bullet points from hero (copy stays in translations for potential reuse elsewhere)
- 2-column grid layout
- Current hardcoded mock agenda (replaced by 4 tab-switchable mocks)
- Feature pills below the old mock

### Performance
- Zero new dependencies
- Pure CSS transitions for crossfade
- All mock screens are lightweight styled divs
- No lazy loading needed — total added markup is minimal

