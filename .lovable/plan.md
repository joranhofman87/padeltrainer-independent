
# Move Specializations and Certifications to Sidebar

## What changes
Move the Specializations and Certifications cards from the main content column (left) to the sidebar column (right), placing them directly below the Contact Info card.

## Technical Details

### File: `src/pages/TrainerProfile.tsx`

**Remove from `ProfileMainColumn`** (lines 613-654):
- The Specializations card block (lines 613-632)
- The Certifications card block (lines 634-654)

**Add to `ProfileSidebarColumn`** (after the `ProfileContactCard` at line 840, before the social links):
- Specializations card
- Certifications card

The JSX content stays identical -- it's purely a move from the left column to the right column. No logic, data, or styling changes needed.
