## Goal

Make the Agenda page the calmest, clearest screen in the app. An academy owner should land on it and instantly see: *what is happening this week, per trainer, today highlighted*. Everything else (cycles, hours, reports, create) stays one click away but stops competing for attention.

## What changes for the user

### 1. New default landing view: "Week, per trainer"

When you open Agenda you see:

```text
┌─────────────────────────────────────────────────────────────┐
│  Agenda                                Mon 11 – Sun 17 May  │
│  Week · Day · Month                  [‹] [Today] [›]   [+]  │
├─────────────────────────────────────────────────────────────┤
│        Mon 11   Tue 12   Wed 13  Thu 14  Fri 15  Sat  Sun  │
│        ───────  ───────  ─────── ▍TODAY  ─────── ─────  ─── │
│                                                             │
│ 🟢 Lisa    ●●        ●           ●●●     ●               2h │
│            2 sess.   1 sess.     3 sess.   1 sess.          │
│                                                             │
│ 🟠 Mark              ●●●●        ●●                     5h │
│                                                             │
│ 🔵 Sara    ●         ●●          ●        ●●●           3h │
│                                                             │
│ … total this week · 24 sessions · 36 h · 78 % filled        │
└─────────────────────────────────────────────────────────────┘
```

Key properties:
- One row per trainer (swimlane), seven day columns, today highlighted with a subtle accent column.
- Each cell shows *count + small dots*, color-coded by fill rate (open / partial / full / past = muted).
- Click a cell → drills into that trainer's day. Click a trainer name → filters whole week to that trainer.
- Right side shows the trainer's weekly hours total, so "per trainer" is readable at a glance.
- Footer strip: total sessions, total hours, fill rate. The numbers users actually care about.

### 2. View switcher: Week / Day / Month (not 6 tabs)

Replace the current 6-tab bar with a slim segmented control: **Week · Day · Month**. The other functions move into less prominent places:
- **Cycles** → small link "View cycles" in header (still routes to existing cyclus overview).
- **Trainer hours** → opens from a "Hours" pill in the week footer (same component, just relocated).
- **Reports** → pill next to it.
- **Create cyclus** → already accessible via the prominent `+ New` button in the header; tab removed.

Result: the page header is one row of controls, not three.

### 3. Day view (redesign)

Single day, one column per trainer (configurable), 60px/hour timeline. Each session becomes a calm card:
- Trainer avatar + first name only (no badge soup)
- Time on top, location subtle below
- Filled state → soft brand tint; open spots → outlined; past → muted
- Status communicated by *one* dot color, not chips
- Click anywhere → slot detail page (already exists)

Drop the current legend strip; instead put a tiny `i` info popover.

### 4. Month view (new, lightweight)

Standard month grid. Each day cell shows:
- Day number
- Total sessions number (big, muted)
- Up to 3 colored dots per trainer present that day
- Today: soft brand background

Click a day → jumps to Day view for that date.

### 5. Filters

Move trainer + location filters into a single "Filters" popover triggered by an icon button in the header. Default = all. When a filter is active, show one removable chip under the header. No filter row by default.

### 6. Visual language (full redesign, still minimal)

Following `docs/DESIGN_SYSTEM.md` and `/brand`:
- White background, generous whitespace, 1px hairline borders only where structural.
- Typography: `font-display` for the date range and section labels, `font-sans` numbers.
- One accent color (brand) for "today", "selected", and primary CTA. Status uses neutral / brand-soft / muted only — drop amber + emerald + colored borders from chips.
- Each trainer gets ONE assigned soft hue from a 6-color palette (derived from brand + navy tokens), used only as a 6px left bar on their swimlane / dot color. Never as backgrounds.
- Replace all `bg-amber-…` / `bg-emerald-…` ad-hoc colors with semantic tokens (`bg-muted`, `bg-primary/10`, `text-muted-foreground`).
- Remove card borders inside cards (no nested shells). The whole agenda lives in one outer card.

### 7. Empty + loading states

- Skeleton matches final layout (rows + cells), not a generic 600px block.
- Empty week → centered illustration-free message: "No sessions planned this week" + `+ Add session` button.

### 8. Mobile

- Week view collapses to a vertical "today + next 6 days" stack, each day card grouped by trainer (matches your "Stacked cards per trainer" preference).
- View switcher and date controls stay sticky at top while scrolling sessions.

## What stays the same
- All data sources, queries, slot click → `/app/academy/slot/:id`, create flows.
- Cycles overview, trainer-hours, reports tabs are kept but accessed from header links instead of tabs.
- `AcademyDayGrid` keeps its 60px/hour grid contract (per memory rule).

## Technical sketch (for engineers)

Files touched:
- `src/pages/academy/AcademyCalendar.tsx` — replace tab bar with `view: "week" | "day" | "month"` URL state; trim header to a single row; lift filters into popover; move cycles/hours/reports to header links / inline sections.
- New `src/components/academy/AgendaWeekByTrainer.tsx` — swimlane grid (7 cols × N trainer rows), per-cell aggregate, footer totals.
- New `src/components/academy/AgendaMonth.tsx` — month grid, per-day totals + trainer dots.
- Refactor `AcademyDayGrid.tsx` visuals only: card design, drop legend, semantic tokens, 6-color trainer palette helper.
- New `src/components/academy/agendaTokens.ts` — `getTrainerHue(trainerId, index)` → returns one of 6 HSL tokens; `getFillState(active, max)` → `"open" | "partial" | "full"`.
- Reuse existing `AcademyTrainerHours`, `AcademyReportsTab`, `AcademyCyclusOverview` mounted from header buttons (open as full-page tabs via existing `?tab=` param, kept for backwards-compat but not shown as a tab strip).

Out of scope:
- No data-model changes, no new endpoints, no business-logic changes.
- No changes to slot creation or slot detail pages.
- Trainer-side `/app/trainer/calendar` is *not* touched in this plan; once you approve the look, we'll mirror it there to keep parity (memory: Trainer-Academy parity).

## Acceptance check

- Land on `/app/academy/calendar` → see week-by-trainer overview, today highlighted, totals visible, no tab bar.
- Switch Week / Day / Month from one segmented control.
- Per-trainer info readable without opening filters.
- All colors come from design tokens; no `amber-*` / `emerald-*` in the agenda components.
- Mobile: stacked cards per trainer per day, no horizontal scroll.
