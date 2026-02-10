

## Fix Cut-Off Avatar Photos

### Problem
The base `AvatarImage` component uses `object-contain`, which shrinks photos to fit inside the circular frame without cropping. This causes portrait or non-square photos to appear small or oddly framed -- as seen on the "Trainer Test" profile.

The standard behavior for avatar circles is `object-cover`, which fills the circle and crops any overflow.

### Solution
Change the default class in `src/components/ui/avatar.tsx` from `object-contain` to `object-cover` on the `AvatarImage` component (line 22).

This is a one-line change that fixes all avatars across the app (sidebars, profile cards, admin tables, edit dialogs, etc.). A few places like `AdminTrainers.tsx` already pass `className="object-cover"` as an override -- those will simply be redundant now, no harm done.

### Technical Details

**File:** `src/components/ui/avatar.tsx`, line 22

Change:
```
className={cn("aspect-square h-full w-full object-contain", className)}
```
To:
```
className={cn("aspect-square h-full w-full object-cover", className)}
```

No other files need changes.

