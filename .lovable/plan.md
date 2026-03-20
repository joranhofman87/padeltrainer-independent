

# Fix Blog Content Not Rendering

## Problem
Exact same issue we fixed for Rules pages. The blogPost schema in Sanity now uses a `content` field (Portable Text), but the frontend queries only fetch `bodySections` (legacy plain-text format) and renders via `BodySections` component which expects simple `{heading, content}` objects.

## Changes

### 1. Update GROQ queries to include `content` field
In `src/lib/sanity.ts`, add `content` to all three blog queries:
- `BLOG_POSTS_QUERY`
- `BLOG_POSTS_BY_CATEGORY_QUERY`  
- `BLOG_POST_BY_SLUG_QUERY`

Also add the related fields from the screenshot: `audience`, `relatedGuides`, `relatedStrokes`, `topics`.

### 2. Update Article type in `src/lib/blog.ts`
Add `content?: any[]` to the `Article` interface.

### 3. Update `BlogPost.tsx` rendering logic
Prioritize `content` over `bodySections`, same pattern as Rules:

```tsx
{post.content && post.content.length > 0 ? (
  <PortableTextRenderer content={post.content} />
) : (
  <BodySections sections={post.bodySections} />
)}
```

Import `PortableTextRenderer` (already exists in the project).

### 4. Fix `calculateReadTime` in `src/lib/blog.ts`
Update to handle Portable Text blocks in `content` field, not just legacy `bodySections`.

