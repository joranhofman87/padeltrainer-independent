

# Add Rich Text Editor to Cycle Description Fields

## Problem
The cycle description fields (for both events and registrations) currently use plain `<Textarea>` components. Users want formatting: line breaks, bullet points, and numbering.

## Solution
Replace the two `<Textarea>` elements in `CycleForm.tsx` with the existing `<RichTextEditor>` component (already built at `src/components/ui/rich-text-editor.tsx` using TipTap). The description field already stores HTML (rendered via `dangerouslySetInnerHTML` in `CycleDetailDisplay` and `AcademyOpenCycles`), so no display-side changes are needed.

## Changes

| File | Change |
|---|---|
| `src/components/cycles/CycleForm.tsx` (lines 393-426) | Replace both `<Textarea>` for event and registration descriptions with `<RichTextEditor value={field.value} onChange={field.onChange} placeholder={...} />` |

Two spots to update:
1. **Event description** (line 401): `<Textarea>` → `<RichTextEditor>`
2. **Registration description** (line 417): `<Textarea>` → `<RichTextEditor>`

No other files need changes — the description is already rendered as HTML everywhere it's displayed.

