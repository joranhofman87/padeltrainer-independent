

# Reorganize Invoices Page + Sidebar Navigation

## Current state
- Sidebar has a collapsible "Zakelijk" (Business) group with 3 sub-items: Instellingen, Abonnement, Facturen
- Invoice settings live on the separate AcademySettings page
- Subscription is a separate page under the Business group

## Changes

### 1. AcademySidebar.tsx — Flatten invoices, remove Business group, move subscription

- Remove the entire "Zakelijk" collapsible group
- Add **Facturen** as a top-level sidebar item (with FileText icon), linking to `/app/academy/invoices`
- Move **Instellingen** up as a top-level sidebar item (with Settings icon)
- Move **Abonnement** to the footer area (near ThemeToggle/Logout), as a small CreditCard icon button that navigates to `/app/academy/subscription`
- Remove `businessOpen` state since the collapsible is gone

### 2. AcademyInvoices.tsx — Add tabs: Overview + Settings

- Wrap existing invoice content in a `Tabs` component with two tabs: **Overview** and **Settings** (Instellingen)
- **Overview tab**: Contains the current stats cards, action buttons, filters, and invoice table (everything that's there now). Remove the "Factuur instellingen" link button since settings are now a tab away
- **Settings tab**: Render `<AcademyInvoiceSettingsCard>` and `<ExtraCostPresetsCard>` (currently on AcademySettings page)
- Support `?tab=settings` URL param so the settings link from other places can deep-link

### 3. AcademySettings.tsx — Remove invoice settings section

- Remove the `<AcademyInvoiceSettingsCard>` and its import from the settings page since it now lives under the Invoices Settings tab

## File summary

| File | Change |
|------|--------|
| `src/components/academy/AcademySidebar.tsx` | Remove Business collapsible, add Facturen + Instellingen as top-level items, add Abonnement icon to footer |
| `src/pages/academy/AcademyInvoices.tsx` | Add Overview/Settings tabs, embed invoice settings card in Settings tab |
| `src/pages/academy/AcademySettings.tsx` | Remove `AcademyInvoiceSettingsCard` section |

