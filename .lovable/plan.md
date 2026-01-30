
# Plan: Fix Stretched Logos on Academy and Location Cards

## Problem

Logos on academy cards and location cards are being stretched to fill the square avatar container. This happens because the `AvatarImage` component uses `aspect-square h-full w-full` which forces images into a square shape, distorting non-square logos.

## Solution

Add `object-contain` CSS class to the `AvatarImage` component when displaying logos. This will preserve the original aspect ratio of the image while still fitting within the container.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/ui/avatar.tsx` | Add `object-contain` to the default AvatarImage styling |
| `src/pages/Academies.tsx` | Ensure AvatarImage has proper styling for logos |
| `src/pages/AcademyPublicProfile.tsx` | Ensure location logos use object-contain |
| `src/components/locations/LocationCard.tsx` | Ensure logo avatars use object-contain |
| `src/components/profiles/ProfileHeroCard.tsx` | Ensure avatar uses object-contain for logos |

## Technical Changes

### Option A: Fix at Component Level (Recommended)

Update `src/components/ui/avatar.tsx` to include `object-contain` by default:

```tsx
// Before
className={cn("aspect-square h-full w-full", className)}

// After  
className={cn("aspect-square h-full w-full object-contain", className)}
```

This is the simplest fix as it will automatically apply to all avatar images throughout the platform.

### Option B: Fix at Usage Level

Add `object-contain` class when using AvatarImage for logos:

```tsx
<AvatarImage 
  src={academy.logo_url || ''} 
  className="object-contain"
/>
```

This approach requires updating each usage but allows more granular control.

## Recommended Approach

Go with **Option A** - updating the base `AvatarImage` component. The `object-contain` property ensures images scale proportionally within their container without distortion, which is the desired behavior for avatars and logos alike.

## Visual Result

```text
Before:                    After:
+--------+                 +--------+
|  🔴🔴  |  (stretched)    |   🔵   |  (proper proportions)
|  🔴🔴  |                 |        |
+--------+                 +--------+
```

Logos will now display with their correct proportions, centered within the avatar container.
