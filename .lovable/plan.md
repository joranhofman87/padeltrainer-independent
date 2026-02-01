
# Fix: Academies Disappearing After 10-20 Seconds

## Problem
When viewing the academies page (either admin or marketing), the list of academies disappears after approximately 10-20 seconds, showing "No academies found" instead.

## Root Cause Analysis
After investigating the codebase, I've identified two potential causes:

### 1. Admin Page (`/admin/academies`)
The `useAdminAcademies` hook has an `enabled: isAdmin === true` condition. If the admin status temporarily becomes `undefined` during an auth session refresh, the query gets disabled and React Query's default behavior may clear cached data.

### 2. Marketing Page (`/en/academies`)
The page uses a simple `useState` + `useEffect` pattern with an empty dependency array. While this should only fetch once, if the component remounts (due to routing changes) or if the Supabase client token expires mid-session, a silent failure could occur.

The session replay showed "Trainer added" and "Academy updated" toast messages appearing before the data disappeared, indicating the user was interacting with the `AcademyEditDialog`. After saving changes, `invalidateAcademies()` triggers a refetch. If the `isAdmin` check fails temporarily, the query returns empty.

## Solution

### Fix 1: Keep Previous Data During Refetch (Admin Page)
Modify `useAdminAcademies` to use `placeholderData: (previousData) => previousData` to preserve data while refetching.

**File: `src/hooks/useAdminData.ts`**
```typescript
export function useAdminAcademies() {
  const { data: isAdmin } = useIsAdmin();

  return useQuery({
    queryKey: ["admin", "academies"],
    queryFn: async (): Promise<AcademyProfileAdmin[]> => {
      // ... existing code
    },
    enabled: isAdmin === true,
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
    placeholderData: (previousData) => previousData, // ADD THIS LINE
  });
}
```

### Fix 2: Add Error State Handling (Marketing Page)
Add an error state to the Academies page so users can see if something went wrong, and add a retry button.

**File: `src/pages/Academies.tsx`**
- Add `error` state
- Show error message with retry button when fetch fails
- Preserve existing data if refetch fails

### Fix 3: Ensure Admin Check is Stable
Modify `useIsAdmin` to use `staleTime: Infinity` or cache the admin status more aggressively to prevent flapping.

---

## Implementation Details

### Step 1: Update `useAdminData.ts`
Add `placeholderData` to `useAdminAcademies` to keep previous data visible during refetches:

```typescript
// Line ~297, after gcTime
placeholderData: (previousData) => previousData,
```

### Step 2: Update `Academies.tsx` Marketing Page
Add error handling and retry capability:

```typescript
const [error, setError] = useState<string | null>(null);

useEffect(() => {
  async function fetchAcademies() {
    setError(null);
    try {
      const data = await getPublicAcademies();
      setAcademies(data);
    } catch (error) {
      console.error('Error fetching academies:', error);
      setError('Failed to load academies. Please try again.');
    } finally {
      setLoading(false);
    }
  }
  fetchAcademies();
}, []);

// Add retry function
const handleRetry = () => {
  setLoading(true);
  fetchAcademies();
};
```

And update the empty state UI to show error when applicable:
```tsx
{error ? (
  <div className="text-center py-16">
    <Building2 className="h-16 w-16 mx-auto text-destructive mb-4" />
    <h3 className="text-lg font-semibold mb-2">Error loading academies</h3>
    <p className="text-muted-foreground mb-6">{error}</p>
    <Button onClick={handleRetry}>Try Again</Button>
  </div>
) : filteredAcademies.length === 0 ? (
  // existing empty state
)}
```

---

## Files Changed

| File | Action | Changes |
|------|--------|---------|
| `src/hooks/useAdminData.ts` | Edit | Add `placeholderData` to preserve data during refetch |
| `src/pages/Academies.tsx` | Edit | Add error state and retry functionality |

---

## Why This Works

1. **placeholderData**: React Query's `placeholderData` option with a function returning previous data ensures that even during a refetch (triggered by invalidation), the user sees the last known data instead of an empty state.

2. **Error Handling**: By explicitly tracking and displaying errors on the marketing page, users will know if something went wrong rather than seeing a confusing "No academies found" message.

3. **Retry Capability**: Adding a retry button gives users an easy way to recover from transient network issues without refreshing the entire page.
