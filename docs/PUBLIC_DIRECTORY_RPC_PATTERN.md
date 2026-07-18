# Public directory pages — the bounded server-side RPC pattern

Status: canonical (source of truth) | last updated 2026-07-18

Audience / AI-read: yes. Read this before converting any other "browse a public
list, filter/sort/paginate" page. Worked example: `search_public_trainers` (the
`/trainers` marketplace directory).

## The problem this solves

Several public pages fetch **every** row of a public entity, then filter, sort,
paginate, and derive facet options **in React**:

```ts
const { data } = await supabase.from('trainer_profiles_safe').select('*').eq('is_public', true);
// ...then filter/sort/slice `data` client-side
```

This is O(all public rows) per page view. It's fine at dozens of rows; it does
not survive thousands. The fix is never `fetchAllRows` (that just moves the
unbounded fetch from "silently truncated" to "silently expensive" — see
[`supabasePaging.ts`](../src/lib/supabasePaging.ts), which is for admin/owner
bulk jobs, not public-facing directories). The fix is a **bounded server-side
RPC**: the database does the filtering, sorting, and paging; the client asks for
exactly one page and gets back exactly one page.

## The recipe

### 1. One migration, two RPCs

- `search_<entity>(...)` — every filter/sort/page param the UI needs, returns
  `RETURNS TABLE (... one row per card ..., total_count bigint)`. The
  `count(*) OVER ()` window function gives an exact total in the same
  round-trip as the page (see the Known trade-offs section below).
- `get_<entity>_directory_facets()` — the distinct filter *options* (locations,
  categories, tags, …) as **one bounded aggregate query**, never derived by the
  client scanning every row. `RETURNS jsonb` is fine for a handful of small
  arrays/objects; don't over-design this into its own table shape.

Both:
```sql
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
```
`SECURITY DEFINER` because these read across owners (all public trainers/
academies/etc., not just the caller's own rows) — the function body must do the
entitlement filtering itself; RLS on the underlying tables is bypassed. `SET
search_path` pins it against search-path hijacking (standard for every
`SECURITY DEFINER` function in this repo — see
[`INVARIANTS.md`](INVARIANTS.md)).

Lock it down explicitly — don't rely on default grants:
```sql
REVOKE ALL ON FUNCTION public.search_<entity>(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_<entity>(...) TO anon, authenticated;
```

### 2. Bound every dimension

- **Page size**: clamp server-side (`LEAST(GREATEST(p_page_size, 1), 100)`) —
  never trust the client's requested size.
- **Page number**: clamp server-side too (`LEAST(GREATEST(p_page, 1),
  1_000_000)`), defensively — `OFFSET = (page-1)*page_size` is computed as
  `int`; an unclamped huge page value can overflow int32 arithmetic.
- **Ordering must be deterministic**: always end the `ORDER BY` with a stable,
  unique tie-breaker (`name ASC, id ASC`) — without one, rows with equal sort
  keys can shuffle between page 1 and page 2 on repeated requests (a real bug
  class, not a theoretical one).

### 3. Entitlement + privacy: reuse the existing safe views, don't reinvent them

Don't write the "is this row publicly visible + entitled" logic again inside
the RPC. This repo already has audited views that do it:

- `trainer_profiles_safe` — `is_public` + `is_active_subscription` (own
  subscription/trial **or** active-academy coverage, computed in ONE place).
  If you need the equivalent for another entity, look for its `_safe` /
  `_public` view first; only add columns to an existing view rather than
  duplicating the entitlement `EXISTS` clause inline.
- `profiles_public` — the public-safe identity projection (name, avatar, bio,
  location — never email/phone/`user_id`).

**A redundant client-side entitlement check is a smell.** `search_public_trainers`
replaced a client call to `getTrainerIdsInPaidAcademies` that duplicated logic
`trainer_profiles_safe.is_active_subscription` already computed — grep for
similar "is this owner still paying" helpers before adding a new one.

### 4. The RPC's `RETURNS TABLE` is the privacy boundary — enumerate it explicitly

List only the columns the card UI actually renders. Never `SELECT *` or forward
a view's full column set. Pin it with a test:

```ts
it('never returns sensitive fields', async () => {
  const rows = await search({});
  expect(Object.keys(rows[0]).sort()).toEqual([/* exact expected list */]);
});
```

### 5. Preserve exact prior filter semantics — including rounding

If a client-side computation existed before (e.g. `Math.round(avg * 10) / 10`
before comparing against a rating filter), reproduce it **in SQL**, not just
in the display formatting. A raw average and a rounded-then-compared average
disagree at the boundary (a true 4.494 average rounds to a displayed/filterable
4.5, and must clear a `minRating=4.5` filter the same way it always did). Pin
the boundary case with a test — don't just eyeball it.

### 6. Indexes: add only what the RPC's WHERE/JOIN clauses need

- Array `&&` (overlap) filters → `GIN` index on the array column (mirrors
  `idx_academy_player_metadata_tag_ids`).
- A partial index when the predicate is always the same fixed condition
  (`WHERE is_public = true`) — smaller and faster than an unconditional index
  when most rows don't match.
- **Free-text search via `ILIKE`**: this repo has no `pg_trgm` extension
  enabled anywhere yet. Plain `ILIKE '%q%'` is *not* index-assisted — it's a
  sequential scan over the candidate set for every search. That's fine at the
  current & near-term data scale (document this explicitly in the migration,
  the way `search_public_trainers` does). Don't add `pg_trgm` speculatively —
  add it (a real, separate migration) only once search is measurably the
  bottleneck.

### 7. Known, accepted trade-off: exact `total_count` costs O(matched rows)

`count(*) OVER ()` is the standard single-round-trip "give me a page AND the
total" pattern, but Postgres must materialize every row that matches the
filters (including the unindexed `ILIKE` above) **before** the page is sliced
off. The **response** is always bounded to `page_size`; the **work** is not.
This is fine up to tens/hundreds of thousands of candidate rows with the
indexes above in place. If a specific directory's unfiltered candidate set
gets large enough for this to matter, the fix is to stop computing an exact
count on deep pages (estimate via `pg_class.reltuples`, or move to
keyset/cursor pagination) — don't pre-build that complexity before it's
needed.

### 8. The frontend wrapper is also the sanitization boundary

Public directory pages are driven by raw URL query params — a bookmark or a
crawled link can contain anything. The wrapper (not the page component) is the
right place to sanitize, because every future caller inherits the safety net
for free:

- **UUID-typed filters** (`locationId`, …): validate the format client-side;
  a malformed value should degrade to "no filter", never reach the RPC and
  surface a Postgres cast error to a public visitor.
- **Numeric filters**: clamp to non-negative finite values; NaN/Infinity/
  negative → the default, never forwarded raw.
- **Enum-like filters** (`sort`): coerce unrecognized values to the default
  rather than forwarding arbitrary client input into a SQL `CASE` branch.

See `src/lib/publicTrainerDirectory.ts` (`safeNonNegative`, the UUID regex) for
the concrete shape.

### 9. Testing shape

- **pglite integration test** (required) — build a **faithful minimal harness**:
  recreate the entitlement view's exact expression (copy it, don't
  approximate it), create the `anon`/`authenticated`/`service_role` roles the
  `GRANT`/`REVOKE` statements need, then `readFileSync` + `exec()` the **real
  migration file**. Cover: page-size cap, deterministic non-overlapping pages,
  own-entitlement / academy(or-equivalent)-entitlement / private-excluded, the
  search predicate (entitled-only), each filter, the rounding boundary, and
  "no sensitive fields returned". See
  `src/test/searchPublicTrainers.pglite.test.ts`.
- **Wrapper unit test** — pin the sanitization behavior directly (no DB
  needed): malformed UUID → dropped, garbage numbers → defaulted, unrecognized
  enum → coerced. See `src/lib/publicTrainerDirectory.test.ts`.
- **Page component test** — the RPC wrapper is called with URL-derived params;
  pagination is driven by the server's `total_count`, never
  `results.length`; changing a filter resets to page 1; the OLD unbounded
  `.select('*')`/`.eq('is_public', true)` pattern is gone. See
  `src/pages/Trainers.test.tsx`.

## Applying this to another page — checklist

1. Does the page already have an entitlement `_safe` view + a `_public`
   identity view? If not, that's the first thing to build (and it benefits
   every future RPC over that entity, not just this one).
2. Enumerate the exact card fields the UI renders — that list IS the
   `RETURNS TABLE` shape.
3. Enumerate every existing URL filter param and its exact current semantics
   (including any client-side rounding/derivation) — the RPC must reproduce
   them, not "roughly" match them.
4. Check for a redundant client-side entitlement helper the new `_safe` view
   already subsumes (delete it, don't leave it unused).
5. Add only the indexes the new WHERE/JOIN clauses need — don't add
   trigram/full-text speculatively.
6. Write the pglite harness FIRST (faithful entitlement expression + role
   bootstrap + real migration exec) — it catches "the RPC diverges from the
   view's real semantics" mistakes before they ship.
7. Wrapper sanitizes every URL-derived param at the RPC boundary.
8. Update this doc's "Known adopters" list below.

## Known adopters

- `/trainers` marketplace directory → `search_public_trainers` +
  `get_public_trainer_directory_facets` (migration `20260909100000`).

## Parked candidates (same pattern, not yet converted)

- `src/pages/TrainersCity.tsx` + `src/pages/marketing/CityLanding.tsx` — same
  unbounded fetch-all shape, but filter by **all locations in a city** rather
  than a single `location_id`. Needs `search_public_trainers` (or a sibling
  RPC) to gain a city / multi-location parameter before these can adopt the
  pattern; not folded into the `/trainers` PR because it's a real scope
  addition, not a drop-in reuse.
