
# Fix Sitemap 1000-Row Limit

## Problem
The sitemap edge function has the same Supabase 1000-row limit that was just fixed in the frontend. With 1,408 locations and 1,116 cities, the sitemap is missing ~408 location pages and potentially some city pages.

## Solution
Apply the same paginated fetching pattern to the sitemap edge function.

---

## Changes Required

### File: `supabase/functions/sitemap/index.ts`

Add a helper function to fetch all rows with pagination, then use it for locations:

```typescript
// Helper to fetch all rows (handles >1000 limit)
async function fetchAllRows<T>(
  supabase: any,
  table: string,
  selectColumns: string,
  filters?: { column: string; operator: string; value: any }[]
): Promise<T[]> {
  const allRows: T[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from(table)
      .select(selectColumns)
      .range(from, from + pageSize - 1);

    // Apply filters
    if (filters) {
      for (const filter of filters) {
        if (filter.operator === 'eq') {
          query = query.eq(filter.column, filter.value);
        }
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error(`Error fetching ${table}:`, error);
      break;
    }

    if (data) {
      allRows.push(...data);
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }

  return allRows;
}
```

Update the locations fetch to use this helper:

```typescript
// Fetch all active locations (with pagination)
const locations = await fetchAllRows<{ slug: string; city: string; updated_at: string }>(
  supabase,
  'locations',
  'slug, city, updated_at',
  [{ column: 'is_active', operator: 'eq', value: true }]
);
```

---

## Expected Result

| Content Type | Before | After |
|--------------|--------|-------|
| Locations | 1,000 | 1,408 |
| City pages | ~800 (capped) | 1,116 |
| **Total URLs** | ~2,500 | ~4,100+ |

---

## After Deployment

Once deployed, you can:
1. Test the function directly: `curl https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap | grep -c '<url>'`
2. Trigger the GitHub Action to update `public/sitemap.xml`
3. Submit the updated sitemap to Google Search Console
