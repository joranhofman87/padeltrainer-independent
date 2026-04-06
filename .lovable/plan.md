

# Replace Large Academy Dialogs with Dedicated Pages

## Priority candidates

The biggest wins come from converting the most complex dialogs first. Here's the recommended order:

### Tier 1 — High complexity, should definitely become pages

1. **CreateCustomInvoiceDialog → `/app/academy/invoices/new`**
   - Currently a massive form with receiver details, line items grid, VAT calculations, date picker, and notes
   - As a page: more room for the form, better UX on mobile, bookmarkable

2. **EditInvoiceDialog → `/app/academy/invoices/:id/edit`**
   - Same complexity as create, plus management actions (download, mark paid, delete)
   - Route param picks up the invoice ID

3. **GenerateProposalsWizard → Already part of CycleDetail flow**
   - Multi-step wizard crammed into a dialog
   - Should render inline within the cycle detail page instead of overlaying it

### Tier 2 — Medium complexity, good candidates

4. **AddIntakeRequestDialog → Inline form or `/app/academy/cycles/:id/registrations/new`**
   - Used on CycleDetail and IntakeRequests pages
   - Could become an inline expandable form or a sub-route

5. **EditIntakeRequestDialog → Similar treatment**

6. **SlotDetailDialog → Already has a page (`/app/academy/slot/:id`)**
   - The dialog version in the calendar overview can simply navigate to the existing slot detail page instead of opening a dialog

### Tier 3 — Small forms, lower priority

7. **AddAcademyLocationDialog / EditAcademyLocationDialog / RequestLocationDialog** — Could become inline forms on the Locations page
8. **InviteAcademyTrainerDialog / CreateAcademyTrainerDialog** — Could become inline forms or sub-routes on the Trainers page
9. **CycleApplicationModal** — Player-facing, could become a dedicated registration page

### Keep as dialogs (no change needed)
- All `AlertDialog` confirmations (delete, remove, send confirm)
- `BookForPlayerDialog` / `EditBookingDialog` — small contextual actions
- `ReassignPlayerDialog` — contextual within proposals
- `ScoringWeightsDialog` — tiny settings form
- Bulk price dialog on CyclesOverview — single input

## Recommended implementation order

Start with **Tier 1** (invoices create/edit + proposals wizard) since those are the most impactful UX improvements. Each conversion follows the same pattern:

1. Create a new route in `DomainRouter.tsx`
2. Move the form content from the Dialog component into a new page component
3. Replace dialog open/close with `navigate()` / back navigation
4. Update the parent page to use a link/button that navigates instead of opening a dialog

## File summary (Tier 1 only)

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCreateInvoice.tsx` | New page with the form from `CreateCustomInvoiceDialog` |
| `src/pages/academy/AcademyEditInvoice.tsx` | New page with the form from `EditInvoiceDialog` |
| `src/pages/academy/AcademyInvoices.tsx` | Replace dialog opens with `navigate()` calls |
| `src/components/DomainRouter.tsx` | Add routes for `/app/academy/invoices/new` and `/app/academy/invoices/:id/edit` |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Convert from Dialog to inline component |
| `src/pages/academy/AcademyCycleDetail.tsx` | Render wizard inline instead of in dialog |
| `src/components/academy/SlotDetailDialog.tsx` | Replace with navigation to `/app/academy/slot/:id` |
| `src/components/academy/AcademyCalendarOverview.tsx` | Navigate to slot page instead of opening dialog |

