

# Fix Blog Content: Formatting, Full Length, and Auto-Translation

## Problem Summary

Three issues with the current blog generation:

1. **No formatting visible** -- The `@tailwindcss/typography` plugin is installed as a dependency but not registered in `tailwind.config.ts`, so the `prose` CSS classes on the blog post page have zero effect. The HTML tags are there (h2, h3, ul, li, etc.) but render as plain text.

2. **Article cuts off mid-sentence** -- The AI generation call doesn't set `max_tokens`, so the model hits its default output limit and truncates. The current article ends with "Don" mid-word in Phase 2.

3. **English only** -- There's no automatic translation trigger when publishing. Translations exist as a manual button in the admin editor, but nothing fires automatically.

---

## Fix 1: Enable Typography Plugin

**File: `tailwind.config.ts`**

Add `@tailwindcss/typography` to the plugins array alongside `tailwindcss-animate`. This immediately makes the `prose`, `prose-lg`, and `dark:prose-invert` classes work on blog post pages.

---

## Fix 2: Increase AI Output Length and Improve Prompt

**File: `supabase/functions/generate-blog-article/index.ts`**

- Add `max_tokens: 16384` to the AI request body so articles aren't truncated
- Strengthen the prompt to explicitly request 1000-1500 words with proper HTML structure (h2, h3, p, ul/ol, strong, em)
- Add clear instruction: "Write the COMPLETE article. Do not stop early."

---

## Fix 3: Increase Translation Output Length

**File: `supabase/functions/translate-blog-article/index.ts`**

- Add `max_tokens: 16384` to the translation AI request as well, since translations of full articles also need room

---

## Fix 4: Auto-Translate on Publish

**File: `src/pages/admin/AdminBlogEditor.tsx`**

When an article's status changes to "published", automatically trigger translation generation for all missing locales. This happens after the save succeeds:

- Detect when status transitions to "published"
- For each missing locale, call `translate-blog-article` edge function
- Show a toast indicating translations are being generated in the background

---

## Fix 5: Re-generate the Existing Article

After deploying the updated edge function, the existing truncated article should be re-generated. You can do this from the admin Topics page by resetting the topic to "queued" and triggering generation again, or manually editing the article in the admin editor.

---

## Technical Changes

| File | Change |
|------|--------|
| `tailwind.config.ts` | Add `require("@tailwindcss/typography")` to plugins |
| `supabase/functions/generate-blog-article/index.ts` | Add `max_tokens: 16384`, improve prompt for complete articles |
| `supabase/functions/translate-blog-article/index.ts` | Add `max_tokens: 16384` |
| `src/pages/admin/AdminBlogEditor.tsx` | Auto-trigger translations when publishing |

