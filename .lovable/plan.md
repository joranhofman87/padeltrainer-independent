

# Add Trainer Lessons Management Page

## Problem

Trainers currently have no way to create or manage lessons. The setup checklist says "Create your first lesson" but links to the calendar page, which only handles slots and cycluses. Clubs have a full lesson management page (`ClubLessons.tsx`), but trainers have nothing equivalent.

Lessons are required prerequisites for creating slots and cycluses (they define the title, price, duration, max participants, etc.).

## Solution

Create a dedicated `/trainer/lessons` page following the same pattern as `ClubLessons.tsx`, adapted for individual trainer use (no trainer selector needed).

## Changes

### 1. New Page: `src/pages/TrainerLessons.tsx`

A lesson management page with:
- List of existing lessons (title, price, duration, max participants, active status)
- "Create Lesson" button opening a dialog/form
- Edit and delete actions per lesson
- Form fields: title, description, duration (minutes), price, max participants, location (optional), active toggle, payment timing (upfront/after)
- Uses the existing `createLesson`, `getTrainerLessons`, `updateLesson`, `deleteLesson` functions from `src/lib/lessons.ts`

### 2. Route Registration: `src/components/DomainRouter.tsx`

Add a new route inside the trainer layout:
```
<Route path="lessons" element={<TrainerLessons />} />
```

### 3. Navigation Updates

**`src/components/trainer/TrainerSidebar.tsx`**
- Add "Lessons" as a sub-item under the **Schedule** group (alongside Calendar and Open Slots)

**`src/components/trainer/TrainerNavigation.tsx`**
- Add "Lessons" item to the schedule group

### 4. Setup Checklist Fix: `src/components/trainer/TrainerSetupChecklist.tsx`

Update the "Create your first lesson" step route from `/trainer/calendar` to `/trainer/lessons`.

### 5. Translation Keys

Add entries to both `src/i18n/locales/en/trainer.json` and `src/i18n/locales/nl/trainer.json` for:
- `nav.lessons` - navigation label
- `lessons.title`, `lessons.create`, `lessons.edit`, `lessons.delete`
- `lessons.form.*` - form field labels
- `lessons.empty` - empty state message

## Technical Notes

- Reuses existing CRUD functions from `src/lib/lessons.ts`
- Follows the sub-page header pattern used by `OpenSlots.tsx` and `TrainerBookingSettings.tsx` (back arrow + title)
- Uses the same lesson interface/form fields as `ClubLessons.tsx` but without the trainer-selection dropdown
- The `SlotLocationPicker` component can be reused for location selection

