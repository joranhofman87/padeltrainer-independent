
# Plan: Remove "Featured" Badge from Featured Section Cards

## Overview

The user wants to remove the "Featured" badge from the cards shown in the featured sections since the section header already clearly indicates these are featured profiles. The cards in featured sections should look identical to the regular cards.

## Current State

The `FeaturedBadge` component is currently used in 3 places:

| File | Location | How it's used |
|------|----------|---------------|
| `Trainers.tsx` | Line 533 | Inside featured trainer card's `CardContent` |
| `Locations.tsx` | Lines 483-485 | Absolutely positioned on top of `LocationCard` |
| `Academies.tsx` | Line 140 | Inside featured academy card after the name |

## Changes Required

### 1. Trainers.tsx

Remove `<FeaturedBadge />` from line 533 in the featured trainers section.

### 2. Locations.tsx

Remove the wrapper `<div className="relative">` and the `<FeaturedBadge />` overlay (lines 476-486). Just render the `LocationCard` directly like in the regular grid.

### 3. Academies.tsx

Remove `<FeaturedBadge />` from line 140 in the featured academies section. Also add back the description like regular cards have.

### 4. Optional: Remove FeaturedBadge export

If `FeaturedBadge` is no longer used anywhere, we can remove the export from `FeaturedSection.tsx`. However, keeping it for potential future use is fine.

## Visual Result

```text
Before (Featured Section):          After (Featured Section):
+------------------+                +------------------+
| Avatar  Name     |                | Avatar  Name     |
| ⭐ 4.8           |                | ⭐ 4.8           |
| [Featured Badge] |                | €50/hr · 5y exp  |
| €50/hr · 5y exp  |                +------------------+
+------------------+

Cards now look identical to regular grid cards.
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/Trainers.tsx` | Remove `<FeaturedBadge />` from featured section |
| `src/pages/Locations.tsx` | Remove wrapper div and `<FeaturedBadge />` overlay |
| `src/pages/Academies.tsx` | Remove `<FeaturedBadge />` and add description like regular cards |
