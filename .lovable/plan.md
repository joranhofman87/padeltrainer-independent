

# Fix Remaining Security & Production Issues

## 4 fixes in one pass

### 1. Review Tag Manipulation — RLS migration

Current INSERT policy allows any authenticated user to insert tags for any review. Fix: restrict to review owner or admin.

```sql
-- Drop permissive INSERT
DROP POLICY "Authenticated users can insert tag selections" ON review_tag_selections;

-- Owner or admin can insert
CREATE POLICY "Review owner can insert tags"
  ON review_tag_selections FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.id = review_id
        AND (r.player_id = public.get_profile_id_for_user(auth.uid())
             OR public.is_admin(auth.uid()))
    )
  );

-- Owner or admin can delete
CREATE POLICY "Review owner can delete tags"
  ON review_tag_selections FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.id = review_id
        AND (r.player_id = public.get_profile_id_for_user(auth.uid())
             OR public.is_admin(auth.uid()))
    )
  );
```

### 2. XSS Prevention — DOMPurify SafeHtml component

Install `dompurify` + `@types/dompurify`. Create `src/components/ui/SafeHtml.tsx` that sanitizes HTML before rendering.

Replace `dangerouslySetInnerHTML` in 7 files:
- `CycleRegistration.tsx` — cycle description
- `CycleCard.tsx` — cycle description
- `CycleDetailDisplay.tsx` — pricing note
- `OnboardingEmailPreview.tsx` — email body preview
- `EmailCampaignTab.tsx` — campaign preview
- `AdminBlogEditor.tsx` — blog preview
- `TrainerTerms.tsx` — academy terms

Skip `chart.tsx` (internal CSS) and `FAQSection.tsx` (JSON-LD, no user content).

### 3. Console.error → logger.error (5 files)

Replace all `console.error` calls with `logger.error` in:
- `ProposalOverviewPage.tsx` (6 instances)
- `TrainerCreateInvoice.tsx` (1)
- `AcademyInvoices.tsx` (1)
- `AcademyCreateInvoice.tsx` (2)
- `CreateCustomInvoiceDialog.tsx` (2)

### 4. Leaked Password Protection

Enable HIBP password check via the Cloud auth settings tool.

## File summary

| File | Change |
|---|---|
| Migration SQL | Drop permissive INSERT on `review_tag_selections`, add owner-only INSERT + DELETE |
| `src/components/ui/SafeHtml.tsx` | New — DOMPurify wrapper |
| `src/pages/CycleRegistration.tsx` | Use `SafeHtml` |
| `src/components/cycles/CycleCard.tsx` | Use `SafeHtml` |
| `src/components/cycles/CycleDetailDisplay.tsx` | Use `SafeHtml` |
| `src/components/admin/OnboardingEmailPreview.tsx` | Use `SafeHtml` |
| `src/components/academy/EmailCampaignTab.tsx` | Use `SafeHtml` |
| `src/pages/admin/AdminBlogEditor.tsx` | Use `SafeHtml` |
| `src/pages/TrainerTerms.tsx` | Use `SafeHtml` |
| `src/pages/ProposalOverviewPage.tsx` | `console.error` → `logger.error` |
| `src/pages/trainer/TrainerCreateInvoice.tsx` | `console.error` → `logger.error` |
| `src/pages/academy/AcademyInvoices.tsx` | `console.error` → `logger.error` |
| `src/pages/academy/AcademyCreateInvoice.tsx` | `console.error` → `logger.error` |
| `src/components/invoices/CreateCustomInvoiceDialog.tsx` | `console.error` → `logger.error` |
| Auth settings | Enable HIBP check |

