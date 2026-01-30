
# Plan: Review Tags System & Academy Open Registrations Empty State

## Summary

This plan covers two features:
1. **Review Tags**: Add selectable tags to the review system that players can use when leaving reviews, enabling future filtering of trainers by these qualities
2. **Open Registrations Empty State**: Show a friendly message on academy profiles when there are no open registrations
3. **Academy Reviews**: Display aggregated reviews from all trainers connected to the academy (no new review system needed)

## Part 1: Review Tags System

### What It Does
When players leave a review for a trainer, they can select tags describing the trainer (e.g., "Patient", "Challenging", "Great with beginners"). These tags are stored and can later be used to filter trainers.

### Database Changes

**New Table: `review_tags`**
Stores available tags that players can select.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Tag name in English |
| name_nl | text | Tag name in Dutch |
| category | text | Optional grouping (teaching_style, personality, skill_focus) |
| is_active | boolean | Whether tag is available for selection |
| display_order | integer | Sort order |
| created_at | timestamp | Creation date |

**New Table: `review_tag_selections`**
Links reviews to selected tags.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| review_id | uuid | FK to reviews |
| tag_id | uuid | FK to review_tags |
| created_at | timestamp | Creation date |

**RLS Policies:**
- Anyone can view active review tags (SELECT)
- Authenticated users can insert tag selections when creating reviews (INSERT)
- Tag selections are immutable (no UPDATE)
- Admins can manage tags (full CRUD)

**Seed Tags:**
```
Teaching Style: Patient, Challenging, Structured, Flexible, Motivating
Skill Focus: Technical, Tactical, Physical, Mental game
Specialties: Great with beginners, Competition-focused, Kids specialist, Advanced tactics
```

### Code Changes

**File: `src/lib/reviews.ts`**

Add functions:
- `getReviewTags()` - Fetch all active tags
- `createReviewWithTags()` - Create review with selected tags
- `getTrainerTagCounts()` - Get tag frequency for a trainer (for profile display)

**File: `src/components/reviews/ReviewForm.tsx`**

Add tag selection UI:
- Fetch available tags on mount
- Display tags as clickable badges grouped by category
- Include selected tag IDs when submitting review

**File: `src/components/reviews/ReviewCard.tsx`**

Display selected tags on each review as small badges.

**File: `src/components/trainers/TrainerFilters.tsx`**

Add new filter section for review tags:
- Fetch most common tags from trainers in view
- Allow multi-select of tags
- Filter trainers who have reviews with those tags

### UI Preview (ReviewForm)

```text
Rating: ★★★★☆

Tags (select what applies):
┌─────────────────────────────────────────────┐
│ Teaching Style                              │
│ [Patient] [Challenging] [Structured]        │
│ [Flexible] [Motivating]                     │
│                                             │
│ Specialties                                 │
│ [Great with beginners] [Competition-focused]│
│ [Kids specialist]                           │
└─────────────────────────────────────────────┘

Comment: [                                    ]

☐ Post anonymously
```

## Part 2: Open Registrations Empty State

### Current Issue
`AcademyOpenCycles` returns `null` when there are no cycles, showing nothing on the profile.

### Solution
Show a helpful message instead of hiding the section completely.

### Code Changes

**File: `src/components/academy/AcademyOpenCycles.tsx`**

Update lines 88-90 to show empty state:

```tsx
// Before
if (loading || cycles.length === 0) {
  return null;
}

// After  
if (loading) {
  return null;
}

if (cycles.length === 0) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          {t('registration.openCycles', 'Open for Registration')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-center py-8 text-muted-foreground">
          <Calendar className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">{t('registration.noCycles')}</p>
          <p className="text-sm mt-1">{t('registration.checkBackLater')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
```

**File: `src/i18n/locales/en/cycles.json`**

Add to `registration` object:
```json
"noCycles": "No open registrations",
"checkBackLater": "Check back later for upcoming training cycles."
```

**File: `src/i18n/locales/nl/cycles.json`**

Add to `registration` object:
```json
"noCycles": "Geen open inschrijvingen",
"checkBackLater": "Kom later terug voor aankomende trainings-cycli."
```

## Part 3: Aggregated Academy Reviews

### Approach
Since reviews are tied to trainers, we'll aggregate reviews from all trainers connected to the academy and display them on the academy profile.

### Code Changes

**File: `src/lib/reviews.ts`**

Add function:
```typescript
export async function getAcademyAggregatedReviews(academyId: string) {
  // 1. Get all trainer IDs for the academy
  // 2. Fetch reviews for all those trainers
  // 3. Calculate combined average rating
  // 4. Return reviews with trainer info for display
}
```

**File: `src/components/reviews/AcademyReviews.tsx`** (new)

New component that:
- Fetches aggregated reviews from all academy trainers
- Displays combined average rating
- Shows individual reviews with "via [Trainer Name]" attribution
- Uses same ReviewCard component

**File: `src/pages/AcademyPublicProfile.tsx`**

Add the `AcademyReviews` component as a full-width section:
- Position it after the trainers section
- Pass the trainer IDs for fetching
- Show combined rating in the Quick Stats sidebar

## File Change Summary

| File | Change |
|------|--------|
| Database | Create `review_tags` and `review_tag_selections` tables with RLS |
| `src/lib/reviews.ts` | Add tag functions + academy aggregation |
| `src/components/reviews/ReviewForm.tsx` | Add tag selection UI |
| `src/components/reviews/ReviewCard.tsx` | Display tags on reviews |
| `src/components/reviews/AcademyReviews.tsx` | New component for aggregated reviews |
| `src/components/academy/AcademyOpenCycles.tsx` | Add empty state |
| `src/pages/AcademyPublicProfile.tsx` | Add AcademyReviews section |
| `src/components/trainers/TrainerFilters.tsx` | Add tag filter section |
| `src/i18n/locales/en/cycles.json` | Add empty state translations |
| `src/i18n/locales/nl/cycles.json` | Add empty state translations |
| `src/i18n/locales/en/common.json` | Add review tag translations |
| `src/i18n/locales/nl/common.json` | Add review tag translations |

## Implementation Order

1. **Database migration** - Create tables with seed data for tags
2. **Empty state for registrations** - Quick win, simple change
3. **Review tags in form** - Update ReviewForm with tag selection
4. **Review tags display** - Show tags on ReviewCard
5. **Academy aggregated reviews** - Create component and add to profile
6. **Trainer filters by tags** - Add to TrainerFilters (optional, can be Phase 2)
