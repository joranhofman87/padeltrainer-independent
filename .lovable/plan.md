## 1. Fix the "Add link" button in the email composer

**Problem:** Clicking the link icon in the rich text editor toolbar does nothing.

**Cause:** The link button is implemented as a shadcn `Toggle` (a Radix Toggle), which steals focus from the editor on mousedown. By the time `addLink()` runs, the text selection in the editor is lost, so `setLink()` has nothing to attach the link to and silently no-ops. The other toggles (bold/italic/underline) only need an active selection to format, so they hide the issue. Some browsers also dislike `window.prompt` triggered from a Toggle's `onPressedChange`.

**Fix in `src/components/ui/mini-rich-text-editor.tsx`:**
- Replace the link `Toggle` with a plain `Button` styled identically.
- Add `onMouseDown={(e) => e.preventDefault()}` so the editor keeps focus and the selection is preserved when the prompt opens.
- Capture the current URL on the link mark (if any) so the prompt prefills the existing href when editing an existing link, and supports an empty input to remove the link.
- After `setLink`, if no text is selected, insert the URL itself as the link text (so clicking the button on an empty selection still produces a usable link instead of nothing).

No behavior changes for other toolbar buttons.

## 2. Save and resume email campaigns as drafts

**Goal:** A user composing a campaign can save it as a draft, leave the page, and come back later to finish and send it.

**Backend (no schema migration needed):**
- Reuse the existing `email_campaigns` table — it already has `status = 'draft'` and `filters` jsonb.
- Recipients of a draft are stored in the same `email_campaign_recipients` table, with the existing `status = 'pending'` (they are only actually sent when the user hits "Send"). The send flow already inserts these rows; we just insert them at draft time too.
- The existing `send-campaign-emails` edge function already accepts `campaignId` and processes pending recipients, so for a draft-then-send flow we:
  - Update the draft row's `subject`, `body_html`, `filters`, `total_recipients`.
  - Replace its recipient rows (delete-then-insert) so the recipient set always matches the latest filters at send time.
  - Then invoke `send-campaign-emails` with the same `campaignId`.

**UI changes in `src/components/players/EmailCampaignTab.tsx`:**

Composer panel:
- Add a "Save as draft" button next to "Send to N", with a `FileText` icon. Disabled when subject + body are empty.
- Track `currentDraftId: string | null` in component state. Loading a draft sets it; saving updates it; sending a draft updates and then dispatches the same `id`; resetting after a successful send clears it.
- Show a small "Editing draft" indicator in the composer header when `currentDraftId` is set, with an "X" to discard (clears state, does NOT delete the row).
- Auto-fill `currentDraftId` when the user opens a draft from history.

History tab:
- Split the campaigns list into two sections: **Drafts** (status = 'draft') at the top, and **Sent / In progress** below (everything else).
- For each draft row, add icon buttons:
  - **Open** (Pencil) → loads subject, body, filters, and recipients into the composer; sets `currentDraftId`; switches to the Compose tab.
  - **Delete** (Trash) → deletes the draft row (cascade deletes recipient rows via existing FK if present; otherwise delete recipients first), with a confirm.
- Sent campaigns remain read-only (current behavior).

Send flow:
- On "Send", if `currentDraftId` is set, reuse that row (update subject/body/filters, replace recipients, then invoke `send-campaign-emails`). Otherwise insert a new row as today.
- After a successful send, the row's status becomes `sending`/`sent` via the existing edge function. Local state clears `currentDraftId`.

Save-as-draft flow:
- Insert a new row with `status: 'draft'` (or update the existing one) using current subject, body_html, filters, total_recipients.
- Replace its recipient rows with the current `recipients[]`.
- Toast "Draft saved", set `currentDraftId`, refresh the history list. Stay on the compose tab (no reset).

Loading a draft:
- Fetch the campaign row + its `email_campaign_recipients`.
- Populate `subject`, `bodyHtml`, the six `filterX` states from `filters`, and `recipients`.
- Set `currentDraftId`, switch to the compose tab.

### Translation keys (English; user can translate)
Add to the `trainer` namespace under `emailCampaign`:
- `compose.saveDraft` = "Save as draft"
- `compose.draftSaved` = "Draft saved"
- `compose.editingDraft` = "Editing draft — your changes won't be sent until you press Send"
- `compose.discardDraftChanges` = "Discard changes"
- `history.draftsTitle` = "Drafts"
- `history.sentTitle` = "Sent campaigns"
- `history.openDraft` = "Open draft"
- `history.deleteDraft` = "Delete draft"
- `history.confirmDeleteDraft` = "Delete this draft? This can't be undone."

## Out of scope
- No new database tables or RLS changes (existing `email_campaigns` policies already cover drafts).
- No autosave — drafts are explicit-only to keep behavior predictable.
- No draft for templates (templates already serve that purpose for reusable content).