

# Move "New" Button to Tab Bar Level

## Problem
The "New" button appears in different places depending on the active tab (header bar vs inside Overview's navigation row). It should be a single, consistent button next to the tab list that navigates to the Create tab.

## Changes

### 1. `src/pages/academy/AcademyCalendar.tsx`
- **Remove** the "New" button from the header bar (lines 630-647 — the `activeTab !== "overview"` conditional block)
- **Add** a "New" button next to the `TabsList`, inside the flex row at line 654. It calls `setActiveTab("create")`
- **Remove** `onNewClick` prop from the `AcademyCalendarOverview` usage (line 709)

### 2. `src/components/academy/AcademyCalendarOverview.tsx`
- **Remove** `onNewClick` from props interface and the "New" button from the navigation row (lines 218-222)

## Result
One "New" button, always visible at the top of the tabs row, consistently navigates to the Create tab.

