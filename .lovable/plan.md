## Goal

Improve the email campaign composer in the players email tab:
1. Make the email body editor noticeably bigger.
2. Add italic + underline formatting (bold already exists).
3. Add an HTML source view so the trainer can edit raw HTML.
4. Keep test-email recipient typeable (different every time) and make it more discoverable.

## Files

- `src/components/ui/mini-rich-text-editor.tsx` — extend the shared rich text editor.
- `src/components/players/EmailCampaignTab.tsx` — use the new editor capabilities and rework the test-email row.
- `package.json` — add `@tiptap/extension-underline`.
- `src/locales/{en,nl}/trainer.json` (and any other locales used by `emailCampaign.*`) — new strings for HTML view toggle and test-email helper text.

## Changes

### 1. Editor (`mini-rich-text-editor.tsx`)
- Add italic and underline toggle buttons (icons: `Italic`, `Underline` from lucide-react).
- Register `@tiptap/extension-underline`.
- Accept new props:
  - `minHeight?: string` (default `"60px"`). Apply to the `prose` container.
  - `allowHtmlView?: boolean` (default `false`). When true, render a "HTML / Visual" toggle in the toolbar that swaps the `EditorContent` for a monospace `<textarea>` bound to the same `value`/`onChange`. Switching back re-injects the HTML into Tiptap via `setContent`.
- Keep existing bold / list / link controls. Group with separators.

### 2. EmailCampaignTab (`EmailCampaignTab.tsx`)
- Pass `minHeight="320px"` and `allowHtmlView` to `MiniRichTextEditor`.
- Replace the toggleable "Send test" affordance with a single always-visible row directly under the editor:
  - Left: small `Input` for the test recipient email (placeholder uses existing `testEmailPlaceholder` key) — value stays in `testEmail`, can be retyped freely.
  - Right: "Send test" button that calls `handleSendTestEmail` (existing logic, no change).
  - Remove `showTestInput` state and the `FlaskConical` toggle button.
- Keep Preview and Send-to-N buttons in the same action row, with the new test-email row visually grouped above them.

### 3. Translations
Add new keys under `emailCampaign.compose`:
- `htmlView` ("HTML"), `visualView` ("Visual") for the editor toggle.
- Reuse existing `sendTest`, `testEmailPlaceholder` for the inline row.

(NL: sentence case per project convention.)

## Out of scope

- No backend / edge function changes — `send-campaign-emails` already accepts arbitrary `bodyHtml`.
- No changes to template storage (still stores HTML string).
- No changes to recipient filtering or campaign sending logic.
