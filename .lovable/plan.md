## Goal
On the Invoices page (Trainer + Academy), under the "Paid" tab, replace the "Vervaldatum" (Due date) column with "Payment date" showing `paid_at`, and default-sort by most recent payment first.

## Changes

**`src/pages/trainer/TrainerInvoices.tsx` and `src/pages/academy/AcademyInvoices.tsx`**

When the active tab is "paid":
- Render a "Payment date" column (header `invoices.paymentDate`) instead of "Due date", showing `inv.paid_at` formatted (fallback dash when null).
- Sort key becomes `paid_at`, default `desc` so latest paid invoices appear at the top.
- Mobile card view: same swap (show paid date instead of due date for paid invoices).

For the "Unpaid" tab everything stays as today (Due date column, current default sort).

Implementation detail: pick `defaultSortKey`/`defaultDirection` for `useTableSort` based on `activeTab`, and conditionally render the column header + cell.

## Translations
Add `invoices.paymentDate` to all locales (`nl: "Betaaldatum"`, `en: "Payment date"`, plus es/de/fr/it equivalents).

## Out of scope
No DB or business-logic changes. Player-facing `PlayerInvoicesTab` already shows paid date and is unchanged.