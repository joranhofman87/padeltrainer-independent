

# Fix: Racket Finder Returns Zero Results for Advanced Players

## Root Cause

The GROQ sort expression `order(level == "advanced" desc, priceMidpoint desc)` is **invalid GROQ syntax**. Sanity does not support boolean comparison expressions inside `order()`. This causes the query to fail silently, returning zero results for all advanced player searches.

This was introduced in the previous fix — the sort worked conceptually but used syntax Sanity doesn't support.

## Fix

**File: `src/hooks/useRacketFinderQuery.ts`** (lines 79-83)

Replace the invalid sort with valid GROQ. Since the `level in $levels` filter already constrains results, and for advanced players we want premium rackets first, we simply sort by `priceMidpoint desc` for high-budget brackets and `priceMidpoint asc` for lower ones. No need for `level ==` sorting — the filter handles level matching.

Change from:
```ts
const sortOrder = answers.level === 'advanced'
  ? `order(level == "advanced" desc, priceMidpoint ${isHighBudget ? 'desc' : 'asc'})`
  : `order(priceMidpoint ${isHighBudget ? 'desc' : 'asc'})`;
```

To:
```ts
const sortOrder = `order(priceMidpoint ${isHighBudget ? 'desc' : 'asc'})`;
```

This is a one-line change that fixes the query for all cases.

## Files to Change
- `src/hooks/useRacketFinderQuery.ts` — Remove invalid GROQ sort expression (1 line)

