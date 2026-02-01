
# Improve Trainer Card Layout

## Overview
Refine the trainer card design to address two visual inconsistencies:
1. Replace the full "Verified" badge with a subtle green checkmark icon (matching the pattern used on profile pages)
2. Move the KNLTB/rating system information to the top header area of the card to prevent height variations

## Current Issues

### Issue 1: Verified Badge
Currently using a full `<Badge>Verified</Badge>` which takes up horizontal space and competes with the trainer name. The standard pattern (used on profile pages) is a simple green checkmark icon with a tooltip.

### Issue 2: KNLTB Rating Position
The rating (e.g., "KNLTB 1") is positioned at the bottom of the card content area. When some trainers have it and others don't, or when combined with varying bio lengths, the cards become inconsistent in height.

## Solution

### Change 1: Verified Icon
Replace the Badge with a green CheckCircle icon with tooltip:
```text
Before: [Avatar] Trainer Name [Verified Badge] [Follow]
After:  [Avatar] Trainer Name [✓ icon] [Follow]
```

The icon will:
- Use the same green CheckCircle icon from lucide-react
- Include a tooltip showing "Verified profile" on hover
- Be compact and non-intrusive

### Change 2: Move Rating to Header
Place the KNLTB rating inline with the metrics row (Rating, Reviews, Availability, Experience):
```text
Before:
  [Star] 5.0  [Comment] 1  [Calendar] No  [Clock] 12y
  ... bio text ...
  €50/hr                                    KNLTB 1

After:
  [Star] 5.0  [Comment] 1  [Calendar] No  [Clock] 12y  KNLTB 1
  ... bio text ...
  €50/hr
```

This keeps all metric information together and ensures consistent card heights.

## Files Changed

| File | Changes |
|------|---------|
| `src/pages/Trainers.tsx` | 1. Import CheckCircle, Tooltip components. 2. Replace Badge with icon+tooltip for verified. 3. Move rating system display to the info metrics row. Apply to both Featured section and main grid cards. |

## Visual Reference
The verified icon will match the existing pattern in `ProfileHeroCard.tsx`:
- Green CheckCircle icon (h-4 w-4 for cards, smaller than h-5 w-5 on profiles)
- Tooltip with "Verified profile" text
- Positioned immediately after the trainer name

## Technical Notes
- Both the Featured section (lines ~560-640) and main grid (lines ~706-806) need updating
- The TooltipProvider should wrap the icon for hover functionality
- Rating display will join the existing flex row containing Star, MessageSquare, CalendarCheck, and Clock icons
