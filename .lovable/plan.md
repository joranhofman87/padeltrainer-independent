

# Fix: Flash of Translation Keys on Initial Load

## Problem
When visiting `/en` (or any non-Dutch page), raw translation keys like `homev2.hero.h1` flash briefly because:
1. Only Dutch (`nl`) translations are eagerly bundled
2. English is set as `fallbackLng` but its resources are loaded **asynchronously**
3. During the async load, i18next has no English strings to fall back to → shows raw keys

## Fix

**Eagerly import English `common` + `marketing` translations** alongside Dutch in `src/i18n/index.ts`.

English must always be available synchronously because it's the `fallbackLng`. This ensures:
- Visiting `/en` → English strings available immediately, no flash
- Visiting `/nl` → Dutch strings available immediately (already works)
- Visiting `/es`, `/de`, `/fr` → English fallback shown instantly while the target language loads async (acceptable — no raw keys)

### Changes to `src/i18n/index.ts`
- Add eager imports for `en/common.json`, `en/marketing.json`, `en/notifications.json`
- Add `en` to the `resources` object passed to `i18n.init()`
- Mark `en` as already loaded in `loadedLanguages` set (`new Set(['nl', 'en'])`)

This is a 1-file change (~8 lines added/modified). No other files affected.

