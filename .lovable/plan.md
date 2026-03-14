

# Improve Time Windows Layout in Generate Proposals Wizard

## Problem
The "Available time windows" label and "+ Add time window" button are stacked vertically, looking awkward — especially on mobile where the 3 selects + delete button overflow. The label sits alone on one line, the button on another.

## Changes

### `src/components/cycles/GenerateProposalsWizard.tsx`

**1. Label + Add button on the same row** (lines 347-412)
- Put the "Available time windows" label and the "+ Add time window" button in a `flex justify-between items-center` row, so the button sits right-aligned next to the label.
- Make the add button smaller/icon-like with just a `+` icon (no text) to save space, or keep text but move it inline.

**2. Mobile-friendly time window rows** (lines 351-403)
- Change each window row from a single `flex` row to a responsive layout:
  - On mobile: stack as two rows — day select on top (full width), time range (start – end + delete) below
  - On desktop: keep as single row with `flex-wrap`
- Use `w-full sm:w-[120px]` for day select, `flex-1 sm:w-[90px]` for time selects
- Layout:
  ```text
  Mobile:
  [  Monday          ▼ ]
  [ 09:00 ▼ ] – [ 17:00 ▼ ] [🗑]

  Desktop:
  [ Monday ▼ ] [ 09:00 ▼ ] – [ 17:00 ▼ ] [🗑]
  ```

### File
- `src/components/cycles/GenerateProposalsWizard.tsx` — ~20 lines changed in the time windows section

