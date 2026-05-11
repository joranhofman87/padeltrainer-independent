## Problem

On `/app/academy`, the dashboard shows a `ShareableProfileLink` card at the top with the academy slug. Two issues:

1. **Copy link is broken / points to a 404.** `ShareableProfileLink` hardcodes the URL as `https://padeltrainer.ai/{handle}`. The real academy public page lives at `https://padeltrainer.ai/{lang}/academies/{slug}` (see `DomainRouter.tsx` route `academies/:slug`). So the copied URL goes nowhere, and on insecure browser contexts `navigator.clipboard.writeText` can also silently fail with no fallback.
2. **The card is visually too big** for what it is — full-width Card with `p-4 sm:p-6`, a label, an Input, and two icon buttons stacked with helper text.

The user wants the card kept prominent but slimmer, and the copy action to actually work and point to the right URL.

## Changes (frontend only)

### 1. `src/components/profile/ShareableProfileLink.tsx`

- Add a `basePath` prop (e.g. `"academies"`) and an optional `lang` prop. Build the URL via `getMarketingUrl(\`${basePath}/${handle}\`, lang)` from `src/lib/domains.ts`. Fall back to current behavior (`padeltrainer.ai/{handle}`) when no `basePath` is provided so trainer / player usages keep working.
- Compact layout variant: drop the separate `Label` + helper paragraph, use a single inline row — small "Share link" label inline, monospace URL truncated with `truncate`, and Copy + Share icon buttons (`size="icon"`, `h-8 w-8`). Provide a `compact` prop (default false) to opt in without affecting other call sites.
- Reliability: keep `navigator.clipboard.writeText` as the primary path, but add a fallback using a hidden `<textarea>` + `document.execCommand('copy')` when the Clipboard API is unavailable or throws (covers http previews, older Safari, etc.). Keep the existing toast on success / failure.

### 2. `src/pages/academy/AcademyDashboard.tsx`

- Render the share link in a slimmer container — replace the `Card` + `CardContent p-4 sm:p-6` wrapper with a compact bordered row (`rounded-lg border bg-card px-3 py-2 mb-4 flex items-center gap-3`) so the section keeps a clear visual presence at the top of the dashboard but takes roughly half the vertical space.
- Pass `basePath="academies"` (and the active language from `useTranslation().i18n.language` or the existing param if available) to `ShareableProfileLink`, plus `compact`.

### Out of scope

- Trainer / player dashboards (their share links use the legacy host pattern; not requested here).
- Copy translations, analytics, routing, database changes.

## Technical notes

- `getMarketingUrl` already returns the full `https://padeltrainer.ai/{lang}/...` string, ideal for clipboard text.
- Display string for the input shows the URL without the `https://` prefix to keep it compact (matches current style).
- No new dependencies; `compact` mode reuses existing shadcn `Input` + `Button` primitives.
