

## Add Sanity Content Links to Footer

Add the three new CMS-driven sections to the footer in `MarketingLayout.tsx`.

### Changes

**File: `src/components/marketing/MarketingLayout.tsx`**

Add a new footer column called "Learn" (or add items to the existing "Platform" column) with links to:

- **Rules** → `/padel-rules`
- **Strokes** → `/padel-strokes`
- **Coaches** → `/padel-coaches`

The cleanest approach: add a new "Learn" column to the footer grid (changing from 4 to 5 columns on desktop, or keeping 4 and regrouping). This separates editorial/content links from platform links.

**Option chosen**: Add the three links to the existing "Platform" column since it already contains Blog, keeping the grid layout unchanged. The items to add after Blog:

```
Rules      → /padel-rules
Strokes    → /padel-strokes  
Coaches    → /padel-coaches
```

All using `<LocalizedLink>` for language prefix support.

