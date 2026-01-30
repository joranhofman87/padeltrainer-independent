
# Plan: Improve LocationCard Layout

## Overview

Based on the screenshot, the user wants to improve the LocationCard component with three changes:

1. **Remove external link button** - The website link button guides traffic away from the platform
2. **Move verified checkmark to upper right corner** - Position it above the text for better visibility
3. **Show full title** - Remove truncation so the full location name is visible

## Current Issues

Looking at the current `LocationCard.tsx`:
- Line 59: Title has `line-clamp-1` which truncates long names
- Lines 64-79: External link button is shown inline with the title
- Lines 60-62: Verified checkmark is inline next to the title, competing for space

## Proposed Changes

### File: `src/components/locations/LocationCard.tsx`

**1. Remove the external link button (lines 64-79)**
- Delete the entire `{location.website_url && (...)}` block
- URL is still shown on the profile page, just not on the card

**2. Move verified checkmark to top-right corner**
- Add `relative` class to the Card
- Position the CheckCircle icon absolutely in the top-right corner
- Remove it from inline with the title

**3. Allow full title to display**
- Remove `line-clamp-1` from the CardTitle
- Use `break-words` to handle very long names gracefully

## Visual Result

```text
Before:                              After:
+------------------------+           +------------------------+
| [Logo] T.P.V... ✓ [→] |           | [Logo]              ✓  |
| 📍 Address             |           | T.P.V. Udenhout        |
| [badges]               |           | 📍 Address             |
+------------------------+           | [badges]               |
                                     +------------------------+

- Title now fully visible
- No external link button
- Checkmark in corner, out of the way
```

## Code Changes

```typescript
// Updated structure:
<Card className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50 relative">
  {/* Verified badge in top-right corner */}
  {isClaimed && (
    <div className="absolute top-3 right-3">
      <CheckCircle className="h-4 w-4 text-primary" aria-label={t('locations.verified')} />
    </div>
  )}
  
  <CardHeader className="pb-2">
    <div className="flex items-start gap-3">
      {isClaimed && (
        <Avatar className="h-10 w-10 shrink-0">...</Avatar>
      )}
      <CardTitle className="text-lg break-words pr-6">{location.name}</CardTitle>
    </div>
  </CardHeader>
  
  <CardContent>
    {/* Address and badges - unchanged */}
  </CardContent>
</Card>
```

## Summary

| Change | Reason |
|--------|--------|
| Remove external link button | Keep traffic on platform; URL shown on profile page |
| Move checkmark to top-right | Better visibility, doesn't compete with title |
| Remove title truncation | Show full location name |
