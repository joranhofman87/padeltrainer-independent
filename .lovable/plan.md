

# Upgrade Email Composer: Add Bullet Points, Numbering & Links

## Summary
Replace the raw `contentEditable` div with the existing `MiniRichTextEditor` (TipTap-based), extended with bullet list, ordered list, and link support. This keeps the editor lightweight — just 5 toolbar buttons total.

## Changes

### 1. `src/components/ui/mini-rich-text-editor.tsx` — Extend toolbar
- Re-enable `bulletList`, `orderedList` in StarterKit config (remove the `false` overrides)
- Add `Link` extension (from `@tiptap/extension-link`, already installed for `RichTextEditor`)
- Add 3 new toolbar toggles: Bullet List, Ordered List, Link (with prompt for URL)
- Add a separator between Bold and the list buttons for visual grouping
- Keep it minimal: **Bold | Bullet · Numbered | Link** — that's it

### 2. `src/components/academy/EmailCampaignTab.tsx` — Swap editor
- Replace the `contentEditable` div + custom Bold button + `handleEditorInput` with `<MiniRichTextEditor value={bodyHtml} onChange={setBodyHtml} />`
- Keep the `{{name}}` variable insert button in a row above or below the editor
- Remove `insertBold` and `handleEditorInput` helper functions (no longer needed)
- The `{{name}}` insert can append to `bodyHtml` state as before

## What we're NOT adding (to keep it lightweight)
- No headings, no text alignment, no underline, no font sizes
- No image upload — emails should be text-focused
- The toolbar stays to one row with 5 buttons max

## File summary

| File | Change |
|------|--------|
| `src/components/ui/mini-rich-text-editor.tsx` | Enable lists + add Link extension, add 3 toolbar buttons |
| `src/components/academy/EmailCampaignTab.tsx` | Replace contentEditable with `MiniRichTextEditor`, clean up manual editor helpers |

