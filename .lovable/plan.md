

# Default Trainers to Unselected

## Problem
Lines 167-179 in `GenerateProposalsWizard.tsx` pre-select all trainers (or those from `applicable_trainer_ids`). Users want to explicitly choose which trainers to include.

## Change

**File: `src/components/cycles/GenerateProposalsWizard.tsx`** (lines 167-179)

Change the pre-selection logic to start with an empty `trainerConfigs` array instead of pre-selecting all trainers:

- If `applicable_trainer_ids` exists and has entries, keep pre-selecting those (they were explicitly chosen before).
- Otherwise, default to an **empty array** instead of selecting all trainers.

This means the badges will all show as `outline` (unselected) by default, and the user must click to select the trainers they want.

