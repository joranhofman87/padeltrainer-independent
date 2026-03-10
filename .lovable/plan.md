

## Mobile Optimization for Registration Pages

### Issues Found

1. **DayAvailabilityPicker — time selectors overflow on mobile**: Each time block row has labels ("From", "To"), two `w-24` Select dropdowns, and a remove button in a flex row. On screens < 375px this wraps chaotically. The `ml-7` left margin further reduces available space.

2. **Rating fields cramped on small screens**: `grid grid-cols-2` for rating + rating system at line 372 doesn't stack on mobile, making inputs tiny.

3. **ProfileLayout breadcrumbs overflow**: Long breadcrumb chains (Home > Academies > Academy Name > Registration) don't truncate or scroll on mobile, pushing content off-screen.

4. **BrandedCycleRegistration hero text**: The `text-3xl` title and meta row don't scale down for mobile.

### Plan

**File: `src/components/cycles/DayAvailabilityPicker.tsx`**
- Remove the text labels ("From"/"To") on mobile, keep only the selects and dash separator
- Reduce `ml-7` to `ml-0 sm:ml-7` so time blocks use full width on mobile
- Make select triggers `w-20 sm:w-24` to save horizontal space
- Stack the time block row vertically on very small screens: use `flex-col sm:flex-row` for each time block

**File: `src/components/cycles/CycleApplicationForm.tsx`**
- Change rating grid from `grid-cols-2` to `grid-cols-1 sm:grid-cols-2` (line 372)
- Lesson type checkboxes: change from `grid-cols-2` to `grid-cols-1 sm:grid-cols-2` (line 512)

**File: `src/components/profiles/ProfileLayout.tsx`**
- Hide middle breadcrumb items on mobile, show only first and last using responsive classes
- Add `overflow-x-auto` on the breadcrumb container so it scrolls if needed
- Reduce header padding on mobile: `px-4 py-3 sm:py-4`

**File: `src/pages/BrandedCycleRegistration.tsx`**
- Scale title: `text-2xl sm:text-3xl`
- Owner avatar: `h-10 w-10 sm:h-14 sm:w-14`

~30 lines changed across 4 files. No new files or dependencies.

