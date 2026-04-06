

# Academy Mobile Optimization Audit

## What's already good

- **Invoices list**: Has a proper `hidden md:block` table + `md:hidden` mobile card layout
- **Dashboard**: Uses `grid-cols-1 md:grid-cols-4` — stacks on mobile
- **Slot detail**: Uses `grid-cols-1 lg:grid-cols-2` — stacks on mobile
- **Calendar tabs**: Uses `text-xs sm:text-sm` for tab labels
- **Filters on Invoices/Cycles**: Uses `flex-col sm:flex-row` wrapping

## Issues found

### 1. Invoice Create/Edit — Line items grid is broken on mobile
Both `AcademyCreateInvoice.tsx` and `AcademyEditInvoice.tsx` use a fixed 6-column grid:
```
grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem]
```
This totals ~350px minimum width with no responsive breakpoint — it overflows or squishes on phones. Needs a stacked mobile layout.

### 2. Cycles tab — Wide table with no mobile card view
`AcademyCyclusOverview.tsx` renders a full `<Table>` with 10 columns (checkbox, name, trainer, location, day/time, period, sessions, players, price, occupancy). No `md:hidden` mobile card alternative exists like on the Invoices page.

### 3. Cycles tab — Filter bar overflows on mobile
The filter bar has search input + 3 dropdowns (time, trainer, location) all in a `flex` row with fixed widths (`w-[140px]`, `w-[160px]`). No wrapping or stacking for small screens.

### 4. Calendar tab bar — 6 tabs overflow horizontally
The calendar has 6 `TabsTrigger` items (Overview, Cycles, Manage, Create, Hours, Reports) in a single `TabsList`. On mobile this likely overflows since `TabsList` doesn't scroll by default.

### 5. Invoice filters — Fixed-width dropdowns
The invoice filter bar has `w-48`, `w-40`, `w-64` fixed-width elements without responsive alternatives.

## Plan

### File 1: `src/pages/academy/AcademyCreateInvoice.tsx`
- On mobile (`md:` breakpoint), switch line items from the 6-column grid to a stacked card-per-item layout
- Each line item becomes a small card with description on top, then quantity/price/vat/total in a 2x2 grid
- Keep the desktop 6-column grid as `hidden md:block`

### File 2: `src/pages/academy/AcademyEditInvoice.tsx`
- Same line items mobile treatment as Create page

### File 3: `src/pages/academy/AcademyCyclusOverview.tsx`
- Add a `md:hidden` mobile card view (like Invoices page already has)
- Each cycle becomes a card showing name, trainer, period, sessions count, and player count
- Keep the desktop table as `hidden md:block`
- Make the filter bar wrap on mobile: `flex-wrap` with `w-full sm:w-auto` on dropdowns

### File 4: `src/pages/academy/AcademyCalendar.tsx`
- Make the `TabsList` horizontally scrollable on mobile using `overflow-x-auto` and `flex-nowrap`
- Ensure the "New" button doesn't get pushed off-screen

### File 5: `src/pages/academy/AcademyInvoices.tsx`
- Make filter dropdowns use `w-full sm:w-48` so they stack full-width on mobile
- Search input: `w-full sm:w-64`

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCreateInvoice.tsx` | Responsive line items: stacked cards on mobile |
| `src/pages/academy/AcademyEditInvoice.tsx` | Same responsive line items treatment |
| `src/pages/academy/AcademyCyclusOverview.tsx` | Add mobile card view + responsive filter bar |
| `src/pages/academy/AcademyCalendar.tsx` | Scrollable tab bar on mobile |
| `src/pages/academy/AcademyInvoices.tsx` | Responsive filter widths |

