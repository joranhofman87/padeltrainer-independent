

# Mobile Optimization: Remaining Pages Without Mobile Views

## Current state

Several pages already have proper mobile treatment with `hidden md:block` tables + `md:hidden` card views:
- Academy Invoices, Trainer Invoices
- Academy Cycles Overview
- Academy/Trainer Create/Edit Invoice (line items)

## Pages that still need mobile card views

These pages render raw `<Table>` components that overflow horizontally on mobile:

### 1. TrainerPlayers — Players table (6 columns, no mobile cards)
Add `hidden md:block` on the table, add `md:hidden` card list showing name, contact, status, and action menu.

### 2. AcademyPlayers — Players table (7 columns including Trainer, no mobile cards)
Same treatment. Cards show name, trainer, status, contact.

### 3. AcademyTrainers — Trainers table (4 columns, no mobile cards)
Add mobile card view with avatar, name, locations, visibility toggle, and action buttons.

### 4. TrainerCyclus — Header layout issue
The header has title + button side-by-side which can overflow on small screens. The stats section (upcoming/players counts) in each card also crowds on mobile. Fix with `flex-wrap` and stacked layout on small screens.

## Other mobile tweaks

### 5. AcademyDashboard — Trainer grid cards
The trainer cards grid uses `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` which is fine, but the trainer detail cards inside have horizontal stat layouts that could benefit from tighter spacing on mobile.

### 6. Slot detail pages (Academy + Trainer)
The two-column grid already stacks on mobile (`grid-cols-1 lg:grid-cols-2`), but the edit form inside uses `grid-cols-2` without a responsive prefix — should be `grid-cols-1 sm:grid-cols-2`.

## File summary

| File | Change |
|------|--------|
| `src/pages/TrainerPlayers.tsx` | Add mobile card view for players table |
| `src/pages/academy/AcademyPlayers.tsx` | Add mobile card view for players table |
| `src/pages/academy/AcademyTrainers.tsx` | Add mobile card view for trainers table |
| `src/pages/TrainerCyclus.tsx` | Responsive header + card stats layout |
| `src/pages/academy/AcademySlotDetail.tsx` | Fix edit form grid to `grid-cols-1 sm:grid-cols-2` |
| `src/pages/trainer/TrainerSlotDetail.tsx` | Same edit form grid fix |

