

# Pre-Launch Code Quality & Polish Plan

A comprehensive plan to ensure the application is in the best possible shape before going live. This covers code hygiene, testing infrastructure, performance optimizations, and component refactoring.

---

## Priority 1: Migrate Remaining Console Statements to Logger

**Issue**: The LAUNCH_CHECKLIST states "No production console.log statements" but there are still ~1,725 instances across 130 files.

**Action**: Focus on the most critical user-facing components first:

| File | Lines | Change |
|------|-------|--------|
| `src/pages/NotFound.tsx` | 16 | Replace `console.error` with `logger.warn` |
| `src/components/trainer/BookForPlayerDialog.tsx` | 131, 147, 166, 300, 358, 376 | Replace `console.error/log` with `logger.error` |
| `src/components/trainer/AddSlotDialog.tsx` | Throughout | Replace `console.error` with `logger.error` |

**Note**: Edge functions (`supabase/functions/*`) can retain `console.log` as they run server-side with proper logging infrastructure.

---

## Priority 2: Add data-testid Attributes for E2E Testing

**Issue**: Zero `data-testid` attributes found. E2E tests rely on fragile text/class selectors.

**Action**: Add attributes to critical interactive elements:

| Component | Elements | testid Pattern |
|-----------|----------|----------------|
| Auth forms | Login/signup buttons, inputs | `auth-login-button`, `auth-email-input` |
| Navigation | Sidebar links, header items | `nav-trainer-dashboard`, `nav-player-bookings` |
| Booking flow | Book button, player selects | `booking-confirm-button`, `booking-player-select` |
| Calendar | Add slot button, slot cards | `calendar-add-slot`, `calendar-slot-{id}` |

**Files to modify**:
- `src/pages/Auth.tsx`
- `src/components/trainer/TrainerSidebar.tsx`
- `src/components/player/PlayerNavigation.tsx`
- `src/pages/BookLesson.tsx`
- `src/pages/TrainerDashboard.tsx`

---

## Priority 3: Add Image Lazy Loading

**Issue**: 115 `<img>` tags across 18 files without `loading="lazy"`.

**Action**: Add lazy loading to all non-critical images:

| File | Count | Notes |
|------|-------|-------|
| `src/pages/marketing/Blog.tsx` | 2 | Featured/post images |
| `src/pages/marketing/BlogPost.tsx` | 2 | Post content images |
| `src/pages/academy/AcademyProfile.tsx` | 1 | Banner image |
| `src/components/profiles/ProfileLayout.tsx` | 1 | Banner image |
| `src/pages/admin/AdminLocations.tsx` | 1 | Logo thumbnails |
| `src/pages/admin/AdminAcademies.tsx` | 1 | Logo thumbnails |
| All other admin preview images | ~15 | Preview thumbnails |

**Exception**: Keep eager loading for above-the-fold hero images.

---

## Priority 4: Extract TrainerDashboard Components

**Issue**: At 1,156 lines, `TrainerDashboard.tsx` is 6x larger than other dashboards and harder to maintain.

**Action**: Extract embedded components to separate files:

| New File | Lines | Source |
|----------|-------|--------|
| `src/components/trainer/TrainerTrialBanner.tsx` | ~30 | Lines 1012-1040 |
| `src/components/trainer/TrainerSetupChecklist.tsx` | ~110 | Lines 1043-1156 |

**Benefits**:
- Dashboard reduced to ~1,000 lines
- Components reusable in other contexts
- Easier to test in isolation

---

## Priority 5: Update Launch Checklist

**Issue**: Some items are marked complete but aren't fully accurate.

**Updates needed**:
```markdown
### Code Quality
- [x] All Stripe references removed and replaced with Mollie
- [x] Translation files complete for EN and NL
- [ ] No production console.log statements (converted to logger) ← CHANGE TO INCOMPLETE
- [x] Error boundaries implemented for graceful failure
...

### Testing Infrastructure
- [ ] data-testid attributes on critical UI elements ← ADD NEW
- [ ] Image lazy loading implemented ← ADD NEW
```

---

## Priority 6: Address Remaining TODOs

| Location | TODO | Action |
|----------|------|--------|
| `src/lib/logger.ts:68` | Sentry integration | Add placeholder comment with priority |
| `src/components/cycles/ProposalCard.tsx:194` | Slot picker | Either implement or remove button |

---

## Summary of Files to Modify

| Category | Files | Effort |
|----------|-------|--------|
| Logger migration | 3 files | Low |
| data-testid | 5 files | Low |
| Lazy loading | 18 files | Low |
| Component extraction | 1 file → 3 files | Medium |
| Checklist update | 1 file | Low |
| TODO cleanup | 2 files | Low |

**Total estimated changes**: ~30 files with mostly small, mechanical updates.

---

## What This Won't Cover

1. **RLS Policy Review**: Already documented in security memories; requires database expertise
2. **Sentry Integration**: Requires account setup and secrets configuration
3. **Mobile Testing**: Manual verification needed per LAUNCH_CHECKLIST
4. **Payment Flow Testing**: Requires Mollie test credentials

These are marked in the checklist for manual verification before launch.

