# Plan: Academy Layer with Public Profiles & Cross-Linking

## Implementation Status

### ✅ Phase 1: Database Foundation (COMPLETE)
- [x] Created `academy_profiles` table
- [x] Created `academy_managers` table  
- [x] Created `academy_trainers` table
- [x] Created `academy_locations` table
- [x] Created `academy_stripe_accounts` table
- [x] Created `academy_trainer_invitations` table
- [x] Created `academy_followers` table
- [x] Created `academy_profile_views` table
- [x] Added `academy` to `app_role` enum
- [x] Created secure views (`academy_profiles_public`, `academy_profiles_safe`)
- [x] Created helper functions (`is_academy_manager`, `is_any_academy_manager`, `get_user_academy_ids`, `is_academy_owner`, `academy_has_managers`)
- [x] Added `academy_profile_id` to `availability_slots` for per-slot assignment
- [x] Created trial trigger for 14-day free trial
- [x] Created comprehensive RLS policies for all tables
- [x] Created indexes for slug lookups and availability_slots

### ✅ Phase 2: Academy Core Management (COMPLETE)
- [x] Academy signup and onboarding flow
- [x] Academy profile management (settings, branding)
- [x] Academy managers system
- [x] Basic dashboard with stats
- [x] `AcademyLayout` with navigation

### ✅ Phase 3: Trainer Affiliation (COMPLETE)
- [x] Invite trainers to academy with payment percentage
- [x] Trainer acceptance/decline flow
- [x] Payment percentage configuration
- [x] Trainer visibility settings

### ✅ Phase 4: Location Contracts (COMPLETE)
- [x] Academy-club contract management
- [x] Location picker for academies
- [x] Contract type (exclusive/non-exclusive)
- [x] Contract dates and visibility settings

### ✅ Phase 5: Academy Cycles (COMPLETE)
- [x] Academy cycles management page
- [x] Extended Cycle types to support 'academy' owner_type
- [x] CycleForm updated to support academy with trainer selection

### 🔄 Phase 6: Public Academy Profiles (TODO)
- [ ] Contract terms and expiration

### ⏳ Phase 5: Public Profiles & Cross-Linking
- [ ] Academy public profile page (`/:lang/academies/:slug`)
- [ ] Academies directory (`/:lang/academies`)
- [ ] Trainer profile update - Show academy affiliation with link
- [ ] Location detail update - Show academies at club with links
- [ ] SEO optimization (structured data, meta tags)

### ⏳ Phase 6: Slot-Level Assignment
- [ ] Update `AddSlotDialog` with "Working as" picker
- [ ] Update `BulkCreateSheet` with same option
- [ ] Club calendar respects academy assignments

### ⏳ Phase 7: Payment & Billing
- [ ] Academy Stripe Connect integration
- [ ] Payment routing based on slot assignment
- [ ] Academy subscription billing
- [ ] Earnings dashboard with splits

### ⏳ Phase 8: Analytics & Polish
- [ ] Academy profile views tracking
- [ ] Follow academy functionality
- [ ] Academy performance analytics
- [ ] i18n translations (EN/NL)

---

## Overview

This plan extends the hybrid trainer model to include **public academy profiles** and **cross-linking** between trainers, clubs, and academies. This creates a complete discovery network where:

- Trainers show their academy affiliation on their profile
- Clubs show which academies operate at their location  
- Academies have their own discoverable public profiles
- All links are clickable and lead to the academy profile page

---

## Database Schema

### New Tables

| Table | Purpose |
|-------|---------|
| `academy_profiles` | Academy organization details, branding, verification |
| `academy_profiles_public` | Public view (excludes PII like contact email) |
| `academy_profiles_safe` | Safe view for discovery queries |
| `academy_managers` | Who manages the academy (owners, managers) |
| `academy_trainers` | Trainers affiliated with academy + payment percentage |
| `academy_locations` | Where academy has contracts to operate |
| `academy_stripe_accounts` | Payment processing for academy |
| `academy_trainer_invitations` | Invite flow for trainers |
| `academy_followers` | Players following an academy |
| `academy_profile_views` | Analytics for academy profiles |

### Modified Tables

| Table | Change |
|-------|--------|
| `availability_slots` | Add `academy_profile_id` (nullable FK) for per-slot assignment |
| `app_role` enum | Add `academy` value |

### `academy_profiles` Schema

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Academy name (required) |
| slug | text | URL-friendly unique identifier |
| description | text | About the academy |
| logo_url | text | Academy logo |
| banner_url | text | Banner image |
| contact_email | text | Business contact (PII - hidden in public view) |
| phone | text | Business phone (PII - hidden in public view) |
| website_url | text | Academy website |
| social_instagram | text | Social links |
| social_facebook | text | |
| social_linkedin | text | |
| social_youtube | text | |
| social_tiktok | text | |
| is_verified | boolean | Admin verification status |
| is_public | boolean | Whether academy appears in directory |
| subscription_status | text | trial/active/inactive |
| subscription_tier | text | Plan level |
| trial_ends_at | timestamptz | Trial expiration |
| stripe_customer_id | text | For subscription billing |
| created_by | uuid | User who created it |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `academy_trainers` Schema

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| academy_profile_id | uuid | FK to academy_profiles |
| trainer_profile_id | uuid | FK to trainer_profiles |
| status | text | 'active', 'invited', 'inactive' |
| payment_percentage | numeric | Trainer's cut (e.g., 70%) |
| show_on_academy_page | boolean | Whether to display on public page |
| invited_by | uuid | Manager who invited |
| joined_at | timestamptz | When they accepted |
| created_at | timestamptz | |

### `academy_locations` Schema

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| academy_profile_id | uuid | FK to academy_profiles |
| location_id | uuid | FK to locations |
| contract_type | text | 'exclusive', 'non_exclusive' |
| contract_start | date | When contract began |
| contract_end | date | When contract expires (nullable) |
| is_active | boolean | Currently operating |
| show_on_academy_page | boolean | Display on academy profile |
| show_on_club_page | boolean | Display on club/location page |
| created_at | timestamptz | |

---

## New Pages & Routes

### Public Routes (SEO-friendly, language-prefixed)

| Route | Component | Description |
|-------|-----------|-------------|
| `/:lang/academies` | `Academies.tsx` | Academy directory with search/filter |
| `/:lang/academies/:slug` | `AcademyProfile.tsx` | Public academy profile page |

### App Routes (authenticated)

| Route | Component | Description |
|-------|-----------|-------------|
| `/academy/signup` | `AcademySignup.tsx` | Create new academy |
| `/academy/onboarding` | `AcademyOnboarding.tsx` | Setup wizard |
| `/academy` | `AcademyDashboard.tsx` | Overview & stats |
| `/academy/profile` | `AcademyProfileEdit.tsx` | Edit public profile |
| `/academy/trainers` | `AcademyTrainers.tsx` | Manage trainers |
| `/academy/locations` | `AcademyLocations.tsx` | Manage club contracts |
| `/academy/calendar` | `AcademyCalendar.tsx` | Combined trainer view |
| `/academy/cycles` | `AcademyCycles.tsx` | Training programs |
| `/academy/players` | `AcademyPlayers.tsx` | Student roster |
| `/academy/earnings` | `AcademyEarnings.tsx` | Revenue & payouts |
| `/academy/settings` | `AcademySettings.tsx` | Configuration |
| `/academy/subscription` | `AcademySubscription.tsx` | Billing |

---

## UI Component Updates

### 1. Trainer Profile Page (`TrainerProfile.tsx`)

Add an **"Academy Affiliation"** section:

```text
┌─────────────────────────────────────────┐
│ 🏫 Academy                              │
│                                         │
│ [Academy Logo] Padel Pro Academy        │
│                                         │
│ "Training excellence since 2020"        │
│                                         │
│ [View Academy →]                        │
└─────────────────────────────────────────┘
```

- Only shown if trainer has active `academy_trainers` record
- Links to `/:lang/academies/:slug`
- Shows academy logo, name, and brief tagline

### 2. Location/Club Detail Page (`LocationDetail.tsx`)

Add an **"Academies at this Club"** section:

```text
┌─────────────────────────────────────────┐
│ 🏫 Training Academies                   │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ [Logo] Padel Pro Academy        →  │ │
│ │        "Professional padel..."     │ │
│ │        👥 4 trainers here          │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ [Logo] Amsterdam Padel School   →  │ │
│ │        "Learn padel the..."        │ │
│ │        👥 2 trainers here          │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

- Fetches academies via `academy_locations` where `show_on_club_page = true`
- Each card links to the academy profile
- Shows trainer count at this specific location

### 3. Public Academy Profile Page (`AcademyProfile.tsx`)

Uses the existing `ProfileLayout` pattern (same as trainers/clubs):

```text
┌─────────────────────────────────────────────────────────────┐
│ [Banner Image]                                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [Logo]  Padel Pro Academy              [Follow] [Website]  │
│          ✓ Verified                                         │
│          📍 Active at 5 locations                           │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  ┌─────────────────────────┐  ┌──────────────────────────┐  │
│  │ About Us                │  │ Quick Stats              │  │
│  │                         │  │                          │  │
│  │ Professional padel      │  │ 👥 12 Trainers           │  │
│  │ training academy...     │  │ 📍 5 Locations           │  │
│  │                         │  │ ⭐ 4.9 avg rating        │  │
│  │                         │  │ 📅 Since 2020            │  │
│  └─────────────────────────┘  └──────────────────────────┘  │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  Our Trainers                                    12 trainers │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ [Avatar] │ │ [Avatar] │ │ [Avatar] │ │ [Avatar] │       │
│  │ John     │ │ Sarah    │ │ Mark     │ │ Lisa     │       │
│  │ ⭐ 4.9   │ │ ⭐ 4.8   │ │ ⭐ 5.0   │ │ ⭐ 4.7   │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  Our Locations                                   5 locations │
│  ┌──────────────────┐ ┌──────────────────┐                 │
│  │ TC Amsterdam     │ │ Padel Club       │                 │
│  │ 📍 Amsterdam     │ │ Rotterdam        │                 │
│  │ 👥 4 trainers    │ │ 📍 Rotterdam     │                 │
│  └──────────────────┘ │ 👥 3 trainers    │                 │
│                       └──────────────────┘                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4. Academies Directory Page (`Academies.tsx`)

Similar to the Trainers directory:

- Search by name/location
- Filter by city/region
- Grid of academy cards
- SEO-optimized with structured data

---

## Helper Functions

### New Functions in `src/lib/academy.ts`

```typescript
// Get academy for a trainer (for display on trainer profile)
export async function getTrainerAcademy(trainerProfileId: string)

// Get academies at a location (for display on club page)  
export async function getAcademiesAtLocation(locationId: string)

// Get academy by slug (for public profile page)
export async function getAcademyBySlug(slug: string)

// Get trainers for an academy (for academy profile page)
export async function getAcademyTrainers(academyProfileId: string)

// Get locations for an academy (for academy profile page)
export async function getAcademyLocations(academyProfileId: string)
```

---

## RLS Policies

### `academy_profiles`

- Anyone can view verified, public academies
- Academy managers can view/update their own academy
- Authenticated users can create academies

### `academy_trainers`

- Trainers can view their own academy memberships
- Trainers can update (accept/decline invites)
- Academy managers can manage their academy's trainers
- Public can view active trainers where `show_on_academy_page = true`

### `academy_locations`

- Academy managers can manage their contracts
- Public can view active locations where `show_on_academy_page = true` or `show_on_club_page = true`

---

## Payment Routing (Per-Slot)

When a trainer creates an availability slot:

```text
Working as:
○ Independent (payment goes to me)
○ Padel Pro Academy (payment goes to academy, I get 70%)
```

Payment routing logic:
1. If `slot.academy_profile_id` exists → Route to Academy Stripe
2. Else if `trainer_locations.relationship_type = 'club_trainer'` → Route to Club Stripe  
3. Otherwise → Route to Trainer's personal Stripe

---

## Implementation Phases

### Phase 1: Database Foundation
1. Create all academy tables with RLS policies
2. Add `academy` to `app_role` enum
3. Create secure views (`academy_profiles_public`, `academy_profiles_safe`)
4. Create helper functions (`is_academy_manager`, `get_user_academy_ids`)
5. Add `academy_profile_id` to `availability_slots`

### Phase 2: Academy Core Management
1. Academy signup and onboarding flow
2. Academy profile management (settings, branding)
3. Academy managers system
4. Basic dashboard with stats
5. `AcademyLayout` with navigation

### Phase 3: Trainer Affiliation
1. Invite trainers to academy
2. Trainer acceptance/decline flow
3. Payment percentage configuration
4. Trainer visibility settings

### Phase 4: Location Contracts
1. Academy-club contract management
2. Location picker for academies
3. Visibility settings per location
4. Contract terms and expiration

### Phase 5: Public Profiles & Cross-Linking
1. **Academy public profile page** (`/:lang/academies/:slug`)
2. **Academies directory** (`/:lang/academies`)
3. **Trainer profile update** - Show academy affiliation with link
4. **Location detail update** - Show academies at club with links
5. SEO optimization (structured data, meta tags)

### Phase 6: Slot-Level Assignment
1. Update `AddSlotDialog` with "Working as" picker
2. Update `BulkCreateSheet` with same option
3. Club calendar respects academy assignments

### Phase 7: Payment & Billing
1. Academy Stripe Connect integration
2. Payment routing based on slot assignment
3. Academy subscription billing
4. Earnings dashboard with splits

### Phase 8: Analytics & Polish
1. Academy profile views tracking
2. Follow academy functionality
3. Academy performance analytics
4. i18n translations (EN/NL)

---

## i18n Keys Structure

```
academy:
  directory:
    title: "Padel Academies"
    subtitle: "Find professional training academies"
    searchPlaceholder: "Search academies..."
  profile:
    trainers: "Our Trainers"
    locations: "Our Locations"
    about: "About"
    follow: "Follow"
    following: "Following"
    verified: "Verified Academy"
  trainer:
    partOf: "Part of"
    viewAcademy: "View Academy"
  club:
    academiesHere: "Training Academies"
    trainersHere: "{{count}} trainers here"
```

---

## Summary

| Component | Files Affected |
|-----------|----------------|
| Database | 10 new tables, 1 modified table, new enum value |
| Public Pages | `Academies.tsx`, `AcademyProfile.tsx` |
| App Pages | 10+ new pages under `/academy/*` |
| Profile Updates | `TrainerProfile.tsx`, `LocationDetail.tsx` |
| Layouts | `AcademyLayout.tsx`, `AcademyNavigation.tsx` |
| Lib Functions | `src/lib/academy.ts` |
| i18n | New `academy.json` namespace |

This architecture creates a complete discovery network while maintaining the hybrid trainer model where trainers can work independently, for clubs, or for academies—and switch between modes on a per-lesson basis.

