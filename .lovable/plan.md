

# Plan: Remove Payment Percentage Feature from Academy Trainers

## Overview

The user has clarified that academies pay trainers a salary directly (not a percentage-based split from lesson payments), so the entire "Payment Percentage" feature should be removed from the academy-trainer relationship.

## Current State

The payment percentage slider and display appears in **5 locations**:

| Location | What it shows |
|----------|---------------|
| Admin AcademyEditDialog | Slider when adding trainer + column in trainers table |
| InviteAcademyTrainerDialog | Slider when inviting trainer via email |
| EditAcademyTrainerDialog | Full dialog dedicated to editing percentage |
| AcademyTrainers.tsx | Badge showing "70%" on trainer cards + pending invitations |
| Database | `academy_trainers.payment_percentage` column |

## Proposed Changes

### 1. Admin AcademyEditDialog

**File:** `src/components/admin/AcademyEditDialog.tsx`

Remove:
- The payment percentage slider section when adding a trainer (lines 975-992)
- The "Payment %" column from trainers table (line 1024, 1046)
- The state variable `newTrainerPayment` and its usage
- The `Slider` import if no longer needed

Instead, add trainers directly without needing to set a percentage.

### 2. InviteAcademyTrainerDialog

**File:** `src/components/academy/InviteAcademyTrainerDialog.tsx`

Remove:
- The payment percentage slider section (lines 129-145)
- The `paymentPercentage` state
- The `Slider` import
- The percentage from the email template parameters

### 3. EditAcademyTrainerDialog

**File:** `src/components/academy/EditAcademyTrainerDialog.tsx`

This entire component only exists to edit the payment percentage. Options:
- **Remove entirely** if there's nothing else to edit about an academy trainer
- Or repurpose it for other settings if needed in the future

For now, we'll remove it entirely.

### 4. AcademyTrainers Page

**File:** `src/pages/academy/AcademyTrainers.tsx`

Remove:
- The payment percentage badge from trainer cards (lines 200-203)
- The payment percentage badge from pending invitations (lines 335-337)
- The `Percent` icon import
- The `EditAcademyTrainerDialog` usage (lines 271-274)

### 5. Translation Cleanup

**Files:** 
- `src/i18n/locales/en/academy.json`
- `src/i18n/locales/nl/academy.json`

Remove or keep (for future use):
- `trainerInvitation.paymentPercentage`
- `trainerInvitation.paymentDescription`
- `trainerInvitation.trainerShare`

### 6. Database Consideration

The `academy_trainers.payment_percentage` column will remain in the database but will no longer be used. It can be:
- Set to a default value (like 100) when inserting
- Left as-is for existing records

No database migration is needed since we're just removing the UI.

## Files to Modify

| File | Change |
|------|--------|
| `src/components/admin/AcademyEditDialog.tsx` | Remove payment slider and table column |
| `src/components/academy/InviteAcademyTrainerDialog.tsx` | Remove payment slider section |
| `src/components/academy/EditAcademyTrainerDialog.tsx` | Delete entire file (or repurpose) |
| `src/pages/academy/AcademyTrainers.tsx` | Remove payment badges and edit dialog |
| `src/lib/academy.ts` | Update `inviteAcademyTrainer` to use default percentage |

## Visual Result

```text
Before (Add Trainer):                After (Add Trainer):
+------------------------+           +------------------------+
| Search trainers...     |           | Search trainers...     |
+------------------------+           +------------------------+
| [x] Patrick Bernardus  |           | [x] Patrick Bernardus  |
+------------------------+           +------------------------+
| Payment Percentage 70% |           | [Add Trainer] button   |
| [====O=======]         |           +------------------------+
| Trainer receives 70%   |
+------------------------+
| [Add Trainer]          |
+------------------------+

Before (Trainer Card):               After (Trainer Card):
+------------------------+           +------------------------+
| Avatar  Patrick        |           | Avatar  Patrick        |
| [Verified] [70%]       |           | [Verified] [Visible]   |
| [Visible]              |           +------------------------+
+------------------------+           | [Profile] [Remove]     |
| [Edit] [Profile]       |           +------------------------+
| [Remove]               |
+------------------------+
```

## Summary

This change simplifies the academy-trainer relationship by removing the unused payment percentage feature. Academies handle trainer compensation outside the platform (salaries), so there's no need for percentage-based lesson payment splits.

