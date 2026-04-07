

# Add Italian Language Support

## Scope

Adding Italian (`it`) as the 6th supported language requires changes across ~15 files spanning frontend routing, i18n config, SEO infrastructure, and edge functions.

---

## Changes Required

### 1. i18n Translation Files (NEW)

Create `src/i18n/locales/it/` directory with all 11 namespace JSON files:
- `common.json`, `marketing.json`, `notifications.json`, `auth.json`, `player.json`, `trainer.json`, `club.json`, `cycles.json`, `admin.json`, `academy.json`, `waitingList.json`

Each file will be a copy of the English version with all values translated to Italian. This is the bulk of the work.

### 2. i18n Configuration — `src/i18n/index.ts`

- Add `'it'` to `SUPPORTED_LANGS` array (line 13)
- Add `it` lazy loader in `lazyLoaders` (line 74)
- Add `it` to language detection regex (line 112)

### 3. Frontend Routing & Language Support

| File | Change |
|---|---|
| `src/components/LanguageRouter.tsx` | Add `'it'` to `SUPPORTED_LANGUAGES` array + redirect regex |
| `src/components/LanguageSwitcher.tsx` | Add `{ code: 'it', name: 'Italiano', flag: '🇮🇹' }` to languages list |
| `src/components/SEO.tsx` | Add `it: 'it_IT'` to `OG_LOCALE_MAP` |
| `src/hooks/useLocalizedPath.ts` | No change needed (reads from `SUPPORTED_LANGUAGES`) |

### 4. date-fns Locale Imports (~9 files)

Add `it` import from `date-fns/locale` and add to `dateFnsLocaleMap` / `localeMap` in:
- `src/components/cycles/ProposalScheduleGrid.tsx`
- `src/components/academy/AcademyCalendarOverview.tsx`
- `src/components/academy/AcademyWeekOverview.tsx`
- `src/components/academy/AcademyTrainerHours.tsx`
- `src/components/academy/AcademyDayGrid.tsx`
- `src/components/academy/AcademyReportsTab.tsx`
- `src/pages/TrainerScheduleOverview.tsx`
- `src/components/trainer/CalendarSlotCard.tsx`
- Files currently only importing `nl, enUS` (LocationDetail, OpenSlots, etc.) — add `it`

### 5. Edge Functions — SEO Infrastructure

| File | Change |
|---|---|
| `supabase/functions/sitemap/index.ts` | Add `'it'` to `LANGUAGES` array (line 10). All hreflang generation is automatic. |
| `supabase/functions/render-page/index.ts` | Add `'it'` to `SUPPORTED_LANGS` (line 17), `OG_LOCALE_MAP` (line 19), language regex (lines 32, 34). Add Italian meta text variants in `renderPath`. |
| `supabase/functions/render-page/index.test.ts` | Add `'it'` to the language loop test |
| `supabase/functions/sitemap/index.test.ts` | Add hreflang `"it"` assertion |
| `supabase/functions/llms-full-txt/index.ts` | No structural change needed (URLs are language-agnostic) |

### 6. Static SEO Files

| File | Change |
|---|---|
| `public/robots.txt` | No change needed (language-agnostic) |
| `public/llms.txt` | Update "Available in: EN, NL, ES, DE, FR" → add IT |
| `docs/cloudflare-worker.js` | No change needed (proxies all paths, language-agnostic) |

### 7. Tests

| File | Change |
|---|---|
| `e2e/i18n.spec.ts` | Add Italian route tests (`/it/`, `/it/trainers`, etc.) |

---

## Implementation Order

1. Create all 11 Italian locale JSON files (translated from English)
2. Update `src/i18n/index.ts` + `LanguageRouter.tsx` + `LanguageSwitcher.tsx` + `SEO.tsx`
3. Add `it` to all `dateFnsLocaleMap` instances
4. Update edge functions (sitemap, render-page) + their tests
5. Update `public/llms.txt`
6. Add E2E tests for Italian routes

---

## Note on Translation Quality

The 11 JSON files contain hundreds of translation keys. I'll generate Italian translations programmatically. You may want to have a native speaker review them afterward, especially the marketing namespace which is customer-facing.

