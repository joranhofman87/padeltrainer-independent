
# Add TradeTracker Script to Marketing Pages

## Overview
Add the TradeTracker SuperTag tracking script to the marketing pages only (padeltrainer.ai), excluding the app subdomain (app.padeltrainer.ai).

## Approach
Follow the existing analytics pattern used for Google Analytics:
1. Create a dedicated function to load TradeTracker
2. Only load on the marketing domain
3. Respect cookie consent for tracking purposes

---

## Changes Required

### 1. Create TradeTracker Loader Function
**File: `src/lib/analytics.ts`**

Add a new function to load the TradeTracker script:
- Only loads on marketing domain (padeltrainer.ai)
- Respects analytics cookie consent
- Injects script dynamically into the page

```typescript
function loadTradeTracker() {
  // Only load on marketing domain
  if (!isOnMarketingDomain()) return;
  if (isTradeTrackerInitialized) return;
  
  const _TradeTrackerTagOptions = {
    t: 'a',
    s: '505059',
    chk: 'a6008bc2b069f12d2b9ed64acbcba05b',
    overrideOptions: {}
  };

  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = `https://tm.tradetracker.net/tag?t=${...}`;
  document.body.appendChild(script);
  
  isTradeTrackerInitialized = true;
}
```

### 2. Update initializeAnalytics Function
Add TradeTracker loading alongside Google Analytics:
- Calls `loadTradeTracker()` when analytics consent is given
- Also listens for consent updates to load if user accepts later

---

## Technical Details

| Aspect | Implementation |
|--------|----------------|
| Loading location | Appended to `<body>` (as specified) |
| Domain check | Uses existing `isOnMarketingDomain()` function |
| Cookie consent | Requires analytics consent (same as GA) |
| Script loading | Dynamic via JavaScript |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/analytics.ts` | Add TradeTracker loader function and call it in `initializeAnalytics()` |

---

## Result
- TradeTracker will load on `padeltrainer.ai` marketing pages when users accept analytics cookies
- The app subdomain (`app.padeltrainer.ai`) will NOT load TradeTracker
- Development/preview environments will also skip loading (following marketing domain check)
