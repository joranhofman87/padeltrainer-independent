
# Plan: Simplify Verified Badge and Remove "Academy Manager" from Public Pages

## Overview

Two changes are requested:
1. Remove the "Academy Manager" badge from public academy profile pages
2. Change the "Verified" badge to be just a green icon with tooltip, shown only when verified

## Current State

**AcademyPublicProfile.tsx (line 236-240)**
```jsx
badgeSlot={
  <Badge variant="secondary" className="w-fit">
    <Building2 className="h-3 w-3 mr-1" />
    {t('badge')}  // "Academy Manager"
  </Badge>
}
```

**ProfileHeroCard.tsx (line 125-130)**
```jsx
{isVerified && (
  <Badge className="w-fit mx-auto lg:mx-0 bg-green-500 hover:bg-green-600">
    <CheckCircle className="h-3 w-3 mr-1" />
    {t('verified', 'Verified')}
  </Badge>
)}
```

## Proposed Changes

### 1. Remove "Academy Manager" Badge from Public Profile

**File:** `src/pages/AcademyPublicProfile.tsx`

Remove the `badgeSlot` prop entirely from the `ProfileHeroCard` component on the public academy profile page.

### 2. Change Verified Badge to Icon-Only with Tooltip

**File:** `src/components/profiles/ProfileHeroCard.tsx`

Replace the Badge component with a simple Tooltip-wrapped CheckCircle icon:
- Only show when `isVerified` is true
- Use green color (`text-green-500`)
- Add tooltip on hover showing "Verified profile"

```text
Before:                    After:
+------------------+       +------+
| ✓ Verified      |  -->  | ✓    |  (green, with hover tooltip)
+------------------+       +------+
```

### 3. Update Trainer Cards Verified Icon (Already correct, just add tooltip)

**File:** `src/pages/AcademyPublicProfile.tsx`

The trainer cards already show just an icon, but we should add a tooltip for consistency.

## Technical Implementation

### ProfileHeroCard.tsx Changes

Add imports:
```typescript
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
```

Replace verified Badge with:
```jsx
{isVerified && (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
      </TooltipTrigger>
      <TooltipContent>
        <p>{t('verifiedProfile', 'Verified profile')}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)}
```

### AcademyPublicProfile.tsx Changes

Remove `badgeSlot` prop from `ProfileHeroCard`:
```jsx
<ProfileHeroCard
  name={academy.name}
  avatarUrl={academy.logo_url}
  isVerified={academy.is_verified}
  socialLinks={socialLinks}
  // Remove badgeSlot entirely
  statsSlot={...}
>
```

Add tooltip to trainer verified icons:
```jsx
{trainer.trainer_profile?.is_verified && (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
      </TooltipTrigger>
      <TooltipContent>
        <p>{t('common:verifiedProfile', 'Verified profile')}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
)}
```

## Files to Modify

| File | Change |
|------|--------|
| `src/components/profiles/ProfileHeroCard.tsx` | Replace verified Badge with icon + tooltip |
| `src/pages/AcademyPublicProfile.tsx` | Remove badgeSlot, add tooltip to trainer icons |
| `src/i18n/locales/en/common.json` | Add "verifiedProfile" translation |
| `src/i18n/locales/nl/common.json` | Add "verifiedProfile" translation |

## Visual Result

```text
Before:
[Academy Logo] Academy Name [✓ Verified badge] [Academy Manager badge]

After:
[Academy Logo] Academy Name [✓]  (green checkmark with tooltip "Verified profile")
```

The verified icon will:
- Only appear when profile is verified
- Be colored green (text-green-500)
- Show "Verified profile" tooltip on hover
- Not include any text label
