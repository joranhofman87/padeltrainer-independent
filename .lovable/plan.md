
# Phase 1: Console Statement Migration to Logger Utility

A systematic migration of `console.log/error` statements to the structured `logger` utility across all core library and hook files. This ensures clean production logs, structured error tracking, and a consistent logging pattern across the codebase.

---

## Overview

**Files to modify**: 10 files
**Total console statements to migrate**: ~55 statements
**Approach**: Replace `console.error` → `logger.error`, `console.warn` → `logger.warn`, remove debug `console.log`

---

## File-by-File Changes

### 1. `src/hooks/useAuth.tsx`

| Line | Current | Replace With |
|------|---------|--------------|
| 86 | `console.error('Error fetching subscription:', error)` | `logger.error('Error fetching subscription', error as Error, { component: 'useAuth' })` |
| 112 | `console.error('Error fetching subscription:', err)` | `logger.error('Error fetching subscription', err as Error, { component: 'useAuth' })` |
| 166 | `console.error('Failed to trigger welcome emails:', error)` | `logger.warn('Failed to trigger welcome emails', { component: 'useAuth', error })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 2. `src/lib/club.ts` (~25 statements)

All `console.error` statements will be converted to `logger.error` with appropriate context:

| Function | Change Pattern |
|----------|---------------|
| `isLocationClaimed` | `console.error('Error checking location claim:', error)` → `logger.error('Error checking location claim', undefined, { error })` |
| `getClubProfileByLocation` | `console.error('Error fetching club profile:', error)` → `logger.error('Error fetching club profile', undefined, { error })` |
| `claimClub` | Multiple errors → `logger.error` with context `{ component: 'club', action: 'claimClub' }` |
| All other functions | Same pattern |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 3. `src/lib/academy.ts` (~30 statements)

Same pattern as club.ts:

| Function | Context |
|----------|---------|
| `createAcademy` | `{ component: 'academy', action: 'createAcademy' }` |
| `getAcademyBySlug` | `{ component: 'academy', action: 'getBySlug' }` |
| `inviteAcademyTrainer` | `{ component: 'academy', action: 'inviteTrainer' }` |
| All other functions | Similar structured context |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 4. `src/lib/trainer.ts` (2 statements)

| Line | Change |
|------|--------|
| 27 | `console.error('Error fetching trainer clubs:', error)` → `logger.error('Error fetching trainer clubs', undefined, { error })` |
| 44 | `console.error('Error fetching club profiles:', clubError)` → `logger.error('Error fetching club profiles', undefined, { error: clubError })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 5. `src/lib/locations.ts` (~12 statements)

| Function | Change |
|----------|--------|
| `getActiveLocations` | `console.error('Error fetching locations:', error)` → `logger.error('Error fetching locations', undefined, { error })` |
| `getAllLocations` | Same pattern |
| `getLocationBySlug` | Same pattern |
| All others | Same pattern with function-specific context |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 6. `src/lib/reviews.ts` (1 statement)

| Line | Change |
|------|--------|
| 102 | `console.error('Error inserting review tags:', tagsError)` → `logger.error('Error inserting review tags', undefined, { error: tagsError })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 7. `src/pages/CycleRegistration.tsx` (1 statement)

| Line | Change |
|------|--------|
| 144 | `console.error('Error fetching cycle data:', error)` → `logger.error('Error fetching cycle data', error as Error, { component: 'CycleRegistration', cycleId })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 8. `src/components/ProfileSwitcher.tsx` (1 statement)

| Line | Change |
|------|--------|
| 83 | `console.error('Error fetching profiles:', error)` → `logger.error('Error fetching profiles', error as Error, { component: 'ProfileSwitcher' })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 9. `src/lib/profileViews.ts` (1 statement)

| Line | Change |
|------|--------|
| 30 | `console.error('Failed to record profile view:', err)` → `logger.warn('Failed to record profile view', { error: err })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

### 10. `src/lib/clubProfileViews.ts` (1 statement)

| Line | Change |
|------|--------|
| 30 | `console.error('Failed to record club profile view:', err)` → `logger.warn('Failed to record club profile view', { error: err })` |

**Add import**: `import { logger } from '@/lib/logger';`

---

## Logger Usage Patterns

### Error with Exception
```typescript
// For caught errors where we have an Error object
logger.error('Operation failed', error as Error, { component: 'componentName', action: 'actionName' });
```

### Error without Exception
```typescript
// For Supabase errors (not Error instances)
logger.error('Operation failed', undefined, { error: supabaseError, component: 'componentName' });
```

### Warning (non-critical failures)
```typescript
// For failures that don't break functionality (e.g., analytics)
logger.warn('Non-critical operation failed', { error, component: 'componentName' });
```

---

## Files NOT Being Changed

| File/Directory | Reason |
|----------------|--------|
| `supabase/functions/*` | Edge functions run server-side with proper logging infrastructure |
| `src/lib/logger.ts` | The logger itself uses console internally (correct) |
| Test files | Test console output is expected |

---

## Update to Launch Checklist

After these changes, update `.lovable/LAUNCH_CHECKLIST.md`:

```markdown
### Code Quality
- [x] No production console.log statements (converted to logger)
```

---

## Summary

| Category | Count |
|----------|-------|
| Files modified | 10 |
| Console statements migrated | ~55 |
| New imports added | 10 |
| Patterns established | Error with context, Warning for non-critical |

This migration establishes a consistent logging pattern that will:
1. Keep production logs clean (debug statements only show in development)
2. Provide structured error context for future Sentry integration
3. Store critical errors in sessionStorage for debugging
4. Make it easy to add centralized monitoring later
