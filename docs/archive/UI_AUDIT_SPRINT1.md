# Sprint 1: Premium UI Foundation — Visual Audit

**Date:** 2026-05-30  
**Scope:** Visual only (no logic, API, routing, or behavior changes)

## Top 20 visual inconsistencies

| # | Issue | Affected screens / components | Proposed fix |
|---|--------|------------------------------|--------------|
| 1 | Academy layout has no outlet padding; trainer/player use `p-4 md:p-6` | All academy pages | Add layout padding; pages use `AppPage` without duplicate `px-4` |
| 2 | Double horizontal padding on trainer pages | `TrainerInvoices`, `TrainerBookings`, legacy pages | Replace `container mx-auto px-4` with `AppPage` (`max-w-7xl`, no extra px) |
| 3 | Two header systems (`PageHeader` bold 2xl vs `TrainerPageHeader` 3xl navy) | Invoices, players, trainer shell | Unify to `text-2xl font-semibold tracking-tight`; shared `PageHeader` API |
| 4 | Academy list pages use manual `h1 font-bold` | `AcademyPlayers`, `AcademyCycles`, calendar | Adopt `PageHeader` + `AppPage` |
| 5 | Academy dashboard has no page title | `AcademyDashboard` | Add `PageHeader` with academy name + overview subtitle |
| 6 | Dashboard stat UI diverges (shadcn Card 3xl vs `DashboardStatTile`) | `AcademyDashboard`, `TrainerDashboard` | Align academy stat cards to calmer typography; soften trainer tile labels (no uppercase) |
| 7 | Dashboard activity: raw tables vs list rows | Academy vs trainer dashboards | Unified table density via `ui/table`; academy activity cards use `p-0` content |
| 8 | Inconsistent page title sizes (`text-xl` / `text-2xl` / `text-3xl`) | Academy calendar, player dashboard | Standardize page titles to 2xl semibold |
| 9 | Settings max-width varies (`max-w-2xl` / `3xl` / `4xl`) | Academy, trainer, player settings | `AppPage width="narrow"` for settings |
| 10 | Card padding overrides (`p-4` on root, `pb-2` headers) | Invoices, dashboards | Global card `p-5`; stat/KPI overrides documented |
| 11 | Card border/shadow inconsistent | Player `hover:shadow-lg`, academy hover border | Subtle `border-border/60 shadow-sm`; no heavy hover shadows |
| 12 | Table density split (`py-1.5` custom vs default `p-4`) | Players, invoices, academy dashboard tables | Default table `px-3 py-2.5`; headers `h-10` |
| 13 | Invoice desktop table inside Card without `p-0` | `TrainerInvoices`, `AcademyInvoices` | `CardContent className="p-0"` on table cards |
| 14 | Nested visual noise (boxes in boxes) | Invoice stats + table + filters | Consistent section `space-y-6`; lighter borders |
| 15 | `font-bold` overused on headings and KPIs | Players, invoice stats | Prefer `font-semibold`; tabular nums on metrics |
| 16 | Uppercase micro-labels on trainer stat tiles | `DashboardStatTile` | Normal case `text-xs font-medium text-muted-foreground` |
| 17 | Academy players missing `TableToolbar` pattern spacing | `AcademyPlayers` | `PageHeader` + table card surface classes |
| 18 | Empty states styled differently | Trainer vs academy players | Shared card surface + centered muted empty copy |
| 19 | Form control height already 10 but ring offset heavy | Inputs globally | Softer focus ring (`ring-1 ring-offset-0`) |
| 20 | Vertical rhythm (`py-8` vs `py-6` vs `space-y-4`) | Most app pages | `AppPage` default `space-y-6`; layout owns padding |

## Implementation summary (this sprint)

- **New:** `components/ui/app-page.tsx` — `AppPage`, `appBarClass`, `surfaceCardClass`, `dataTableCardContentClass`
- **Primitives:** `card`, `table`, `input`, `select`, `textarea`, `page-header`, `TrainerPageHeader`, `DashboardStatTile`
- **Layouts:** `AcademyLayout` outlet padding
- **Pages:** Academy + trainer dashboards, players, invoices, settings, cycles, intake (wrapper migration)

## Verification

- No changes to query handlers, `onClick` business logic, form `onSubmit`, or API modules.
- Visual regression: run app and spot-check dashboards, players, invoices.
