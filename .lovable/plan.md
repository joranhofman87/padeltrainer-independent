
# Plan: Add Featured Section to Listing Pages

## Overview

Add a "Featured" section at the top of the Trainers, Locations, and Academies listing pages that showcases profiles with active paid subscriptions. This provides visibility incentives for paying users and helps players discover premium profiles.

## What Makes a Profile "Featured"

A profile is considered "featured" (paid) when:

| Entity | Condition |
|--------|-----------|
| **Trainers** | `subscription_status = 'active'` |
| **Locations** | Location has a claimed club with `subscription_status = 'active'` |
| **Academies** | `subscription_status = 'active'` |

## Design

The featured section will appear below the hero/header and above the regular listing grid:

```text
+--------------------------------------------------+
| Hero Section (title, search, filters)            |
+--------------------------------------------------+
| Featured (highlighted section with gradient bg)  |
| +--------+ +--------+ +--------+ +--------+      |
| | Card 1 | | Card 2 | | Card 3 | | Card 4 |      |
| +--------+ +--------+ +--------+ +--------+      |
+--------------------------------------------------+
| All Trainers/Locations/Academies                 |
| (regular grid of all results)                    |
+--------------------------------------------------+
```

**Design details:**
- Subtle gradient background to distinguish from main content
- Horizontal scrollable carousel on mobile
- Grid of 4 cards on desktop
- "Featured" badge on each card
- Star icon in section header
- Only shows if there are featured profiles
- Randomize order to give fair rotation

## Implementation

### 1. Create Reusable FeaturedSection Component

**New file:** `src/components/featured/FeaturedSection.tsx`

```typescript
interface FeaturedSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  emptyMessage?: string;
}
```

A wrapper component that:
- Provides consistent styling (gradient background, section header with star icon)
- Handles empty state (hides section if no children)
- Adds horizontal scroll on mobile

### 2. Update Trainers Page

**File:** `src/pages/Trainers.tsx`

- Add `featuredTrainers` computed from trainers where `subscription_status === 'active'`
- Shuffle featured trainers for fair rotation
- Limit to 8 featured max
- Render `FeaturedSection` with trainer cards after the hero section
- Add "Featured" badge to trainer cards when shown in featured section

### 3. Update Locations Page

**File:** `src/pages/Locations.tsx`

- Cross-reference with `club_profiles_public` to find locations with active paid clubs
- Featured locations = locations where the claimed club has `subscription_status = 'active'`
- Render `FeaturedSection` with location cards after filters
- Limit to 8 featured max

### 4. Update Academies Page

**File:** `src/pages/Academies.tsx`

- Filter academies where `subscription_status === 'active'`
- Render `FeaturedSection` with academy cards before the regular grid
- Limit to 8 featured max

### 5. Add Translations

**Files:**
- `src/i18n/locales/en/common.json`
- `src/i18n/locales/nl/common.json`

Add keys:
- `featured.title` - "Featured"
- `featured.trainers` - "Featured Trainers"
- `featured.locations` - "Featured Locations"
- `featured.academies` - "Featured Academies"
- `featured.badge` - "Featured"

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/components/featured/FeaturedSection.tsx` | Create | Reusable featured section wrapper |
| `src/pages/Trainers.tsx` | Modify | Add featured trainers section |
| `src/pages/Locations.tsx` | Modify | Add featured locations section |
| `src/pages/Academies.tsx` | Modify | Add featured academies section |
| `src/i18n/locales/en/common.json` | Modify | Add featured translations |
| `src/i18n/locales/nl/common.json` | Modify | Add featured translations |

## Visual Preview

```text
┌────────────────────────────────────────────────────────────────┐
│                     ⭐ Featured Trainers                       │
│                 Premium trainers with verified profiles        │
├────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│ │ Avatar   │ │ Avatar   │ │ Avatar   │ │ Avatar   │           │
│ │ Name     │ │ Name     │ │ Name     │ │ Name     │  ───────► │
│ │ ⭐ 4.8   │ │ ⭐ 4.9   │ │ ⭐ 4.7   │ │ ⭐ 5.0   │   scroll  │
│ │ Featured │ │ Featured │ │ Featured │ │ Featured │           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
└────────────────────────────────────────────────────────────────┘
```

## Summary

| Change | Purpose |
|--------|---------|
| Featured section component | Reusable wrapper for consistent styling |
| Trainers featured section | Showcase trainers with active subscriptions |
| Locations featured section | Showcase clubs with active subscriptions |
| Academies featured section | Showcase academies with active subscriptions |

This incentivizes users to upgrade to paid plans for increased visibility while helping players discover premium profiles.
