

# Replace Trainer Edit Dialog with Dedicated Page

## Problem
Editing a trainer in the academy opens a dialog popup, which is cramped, hard to extend with more fields, and not mobile-friendly. The user wants a dedicated full page per trainer instead.

## Changes

### 1. Create new page: `src/pages/academy/AcademyTrainerDetail.tsx`
- New page at route `/app/academy/trainers/:trainerId`
- Move all the form logic from `EditAcademyTrainerDialog.tsx` into this page
- Full-width layout with sections: avatar/name header, basic info, trainer details (rate, experience), certifications, specializations, rating, social links, coaching method, location assignments, visibility toggle, and a remove trainer action
- Back button to `/app/academy/trainers`
- Save button at the top (similar to `AcademySlotDetail` pattern)

### 2. Add route in `src/components/DomainRouter.tsx`
- Add `<Route path="trainers/:trainerId" element={<AcademyTrainerDetail />} />` under the academy routes

### 3. Update `src/pages/academy/AcademyTrainers.tsx`
- Remove `EditAcademyTrainerDialog` import and usage
- Replace the edit button with a navigation link: clicking the trainer row or the edit icon navigates to `/app/academy/trainers/{trainer.id}`
- Make the trainer name clickable as well

### 4. Remove or deprecate `src/components/academy/EditAcademyTrainerDialog.tsx`
- No longer needed once the page is in place

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyTrainerDetail.tsx` | New page with full trainer edit form |
| `src/components/DomainRouter.tsx` | Add route for `/app/academy/trainers/:trainerId` |
| `src/pages/academy/AcademyTrainers.tsx` | Replace dialog with navigation to detail page |
| `src/components/academy/EditAcademyTrainerDialog.tsx` | Remove (logic moves to new page) |

