
# Plan: Make Featured Cards Same Size as Regular Cards

## Overview

The featured section cards are currently smaller and show less content than the regular grid cards. This creates an inconsistent visual experience. The user wants them to look the same.

## Current Differences

### Academies Page
| Element | Featured Cards | Regular Cards |
|---------|---------------|---------------|
| Avatar | `h-14 w-14` | `h-16 w-16` |
| Title | `text-sm` | (default) |
| Description | `text-xs` | `text-sm` |
| Website URL | Missing | Shown |

### Trainers Page
| Element | Featured Cards | Regular Cards |
|---------|---------------|---------------|
| Avatar | `h-12 w-12` | `h-14 w-14` |
| Title | `text-sm` | `text-base` |
| Location | Missing | Shown |
| Bio | Missing | Shown |
| Verified Badge | Missing | Shown |
| Follow Button | Missing | Shown |
| Rating System | Missing | Shown |
| Specializations | Missing | Shown |

### Locations Page
Already uses the same `LocationCard` component in both sections - no changes needed.

## Solution

Update the featured card markup in each page to exactly match the regular card markup:

1. **Academies.tsx** - Update lines 122-148 to match lines 190-224
2. **Trainers.tsx** - Update lines 503-542 to match lines 609-696

## Changes Required

### File: `src/pages/Academies.tsx`

Expand the featured card to match the regular card:
- Increase avatar size from `h-14 w-14` to `h-16 w-16`
- Remove `text-sm` from title
- Change description from `text-xs` to `text-sm`
- Add website URL display
- Add `mb-2` to description

### File: `src/pages/Trainers.tsx`

Expand the featured card to match the regular card completely:
- Increase avatar size from `h-12 w-12` to `h-14 w-14`
- Increase avatar fallback text from `text-sm` to `text-lg`
- Change title from `text-sm` to `text-base`
- Add verified badge
- Add follow button
- Add location display
- Add bio section
- Add rating system and experience in same layout
- Add specializations badges

### File: `src/pages/Locations.tsx`

No changes needed - already uses `LocationCard` component consistently.

## Result

After changes, the featured section cards will be visually identical to the regular grid cards, just displayed in a horizontally scrollable section with a gradient background.
