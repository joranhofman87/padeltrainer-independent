

# Add missing Dutch translations for registration workflow pages

## Problem
Many components in the registration/cycles workflow use translation keys with English `defaultValue` fallbacks. Since these keys don't exist in the Dutch `cycles.json` file, the UI shows English text when the language is set to Dutch.

## Scope
One file to update: `src/i18n/locales/nl/cycles.json`

The following key groups are missing and need Dutch translations added:

### 1. Workflow steps (`workflow.*`) — 8 keys
- `workflow.registrations` → "Aanmeldingen"
- `workflow.registrationsDesc` → "{{count}} aangemeld"
- `workflow.reviewLinks` → "Koppelingen bekijken"
- `workflow.reviewLinksDesc` → "{{count}} actie(s) openstaand"
- `workflow.reviewLinksDone` → "Alles in orde"
- `workflow.reviewDesc` → already exists
- `workflow.continueToGenerate` → "Doorgaan naar genereren"

### 2. Generate wizard (`proposals.wizard.*`) — ~25 keys
Step labels, start date, select trainers, min/max rating, available time windows, add window, max group size, linked players strategy options, fill incomplete groups, additional criteria, draft restored message, plus all help texts.

### 3. Pre-generation review (`preReview.*`, `suggestions.*`) — ~10 keys
Link suggestions, all clear, resolve first, ready to continue, mentioned, link/dismiss actions, unmatched info.

### 4. Intake request detail & table (`intakeRequests.links.*`, `intakeRequests.actions.*`, `intakeRequests.table.*`) — ~20 keys
Linked with, suggested links, link all, unmatched mentions, dismiss suggestion, search player, columns, toggle columns, delete confirmation, edit actions.

### 5. Proposal grid (`proposals.*`) — ~15 keys
Edit slot, overlap warning, apply, players, delete slot, confirm delete, search player, no players found, existing lesson, blocked slot tooltip, duration mismatch, undo player move, rating out of range.

### 6. Proposal card (`proposals.actions.decline`) — 1 key

## Approach
Add all missing keys to `src/i18n/locales/nl/cycles.json` with proper Dutch translations, following the existing sentence-case convention. No component changes needed — the `t()` calls already reference the correct keys and will automatically pick up the new translations.

## Files

| File | Change |
|------|--------|
| `src/i18n/locales/nl/cycles.json` | Add ~80 missing Dutch translation keys across workflow, wizard, pre-review, intake requests, and proposals sections |

