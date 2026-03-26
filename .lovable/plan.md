

# Add Tooltips to Invoice Action Buttons

## Problem
The action icons (share, send, mark paid, edit, download, forward) on the invoices page only use HTML `title` attributes, which show with a delay and look plain. New users can't easily tell what each icon does.

## Fix
Wrap each action button in a `Tooltip` component (from the existing `@/components/ui/tooltip`) for instant, styled hover labels.

## Changes

| File | Change |
|------|--------|
| `src/pages/academy/AcademyInvoices.tsx` | Import `Tooltip, TooltipTrigger, TooltipContent, TooltipProvider` from `@/components/ui/tooltip`. Wrap the actions `<div>` in `<TooltipProvider>`. Wrap each `<Button>` in `<Tooltip><TooltipTrigger asChild>...<TooltipContent>` with the label text (using existing translation keys like `invoices.shareLink`, `invoices.markPaid`, `invoices.edit`, `invoices.downloadPdf`, `invoices.forwardToBookkeeper`, and a new `invoices.send` key). Remove the `title` attributes from the buttons. |
| `src/i18n/locales/en/common.json` | Add `invoices.send` translation if missing |
| `src/i18n/locales/nl/common.json` | Add `invoices.send` translation if missing |

This gives immediate, visually consistent hover labels on all action icons.

