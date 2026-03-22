

# Fix Racket Finder Quiz — Two Bugs + Page Content

## Bugs Found

### Bug 1: Budget filter is inverted for "€200+"
The budget options map to max price values: `100`, `150`, `200`, `999`. The query uses `priceMidpoint <= $maxPrice`. When someone picks "€200+", it becomes `priceMidpoint <= 999` — which matches ALL rackets. Combined with `order(priceMidpoint asc)`, it returns the 3 **cheapest** rackets first. A user selecting "€200+" expects rackets **above** €200, not below.

### Bug 2: Level matching is too broad for advanced
`getLevels('advanced')` returns `['advanced', 'intermediate', 'all']`. This means an advanced player with a €200+ budget still gets cheap intermediate/beginner-level rackets because the sort is `priceMidpoint asc`.

## Solution

### File: `src/hooks/useRacketFinderQuery.ts`

**1. Change budget from max-price to price range**

Replace the single `maxPrice` filter with both a min and max:

| Quiz option | minPrice | maxPrice |
|------------|----------|----------|
| Under €100 | 0 | 100 |
| €100–€150 | 100 | 150 |
| €150–€200 | 150 | 200 |
| €200+ | 200 | 999 |

Update `QuizAnswers` to store a `budget` that represents the **upper bound** of the selected range, then derive the min from it.

The GROQ filter changes from:
```
priceMidpoint <= $maxPrice
```
to:
```
priceMidpoint >= $minPrice && priceMidpoint <= $maxPrice
```

**2. Sort results by best match, not cheapest**

Change `order(priceMidpoint asc)` to prioritize exact level matches. For advanced players, sort advanced rackets first, then intermediate:
```
order(level == "advanced" desc, priceMidpoint desc)
```

For the €200+ bracket specifically, sort by price descending (best/most premium first). For other brackets, sort by midpoint of range (closest to center).

**3. Increase result count from 3 to 5**

3 results is too few — return 5 to give better variety.

### File: `src/pages/marketing/RacketFinder.tsx`

**4. Update budget step values to encode ranges**

Change budget option values to encode both min and max (e.g., `0-100`, `100-150`, `150-200`, `200-999`), and parse in `handleSelect`.

### File: `src/components/racketfinder/QuizResults.tsx`

**5. Update badges array for 5 results**

Extend the badges to handle up to 5 results instead of 3.

---

### Racket Finder Page Content Enhancement

**File: `src/pages/marketing/RacketFinder.tsx`**

Add content sections below the quiz for SEO and user value:
- "How It Works" — 3-step visual explanation (answer questions → get matched → buy)
- "Why Use Our Racket Finder" — brief value props
- Expand the FAQ structured data with more Q&As
- Add a "Browse All Rackets" link to the catalogue

---

## Files to Change
1. `src/hooks/useRacketFinderQuery.ts` — Fix budget range filter, improve sort order, increase to 5 results
2. `src/pages/marketing/RacketFinder.tsx` — Update budget values to ranges, add page content sections
3. `src/components/racketfinder/QuizResults.tsx` — Support 5 result badges

