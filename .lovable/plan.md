

# Fix Registration Share Link

## Problem
The "Share link" action in `CyclesTable` generates a broken URL: `origin/register/:id` — missing the language prefix. The route is `/:lang/register/:cycleId`, so the link 404s.

`CycleCard` already does this correctly using `getMarketingUrl('register/${cycle.id}', lang)`.

## Fix

| File | Change |
|---|---|
| `src/components/cycles/CyclesTable.tsx` (line 111-114) | Use `getMarketingUrl` with current language instead of manual URL construction |

### Before
```ts
const handleCopyLink = (cycle: Cycle) => {
  const url = `${window.location.origin}/register/${cycle.id}`;
  navigator.clipboard.writeText(url);
  toast.success(t('actions.linkCopied'));
};
```

### After
```ts
const handleCopyLink = (cycle: Cycle) => {
  const lang = i18n.language || 'nl';
  const url = getMarketingUrl(`register/${cycle.id}`, lang);
  navigator.clipboard.writeText(url);
  toast.success(t('actions.linkCopied'));
};
```

Also add the `getMarketingUrl` import from `@/lib/domains`. The `i18n` object is already destructured from `useTranslation` on line 67.

