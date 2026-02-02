

# Fix Logo Scraping Progress Indicator

## Problem
The logo scraping IS working (confirmed via edge function logs), but the UI shows 0% because:
1. Progress only updates after an **entire batch** completes
2. Each website scrape takes 15-30+ seconds
3. With a batch of 10 locations, the first update won't appear for 3-5 minutes
4. There's no visual indicator that work is actively happening

## Solution
Add better feedback to show the scraping is actively working:

---

## Changes Required

### 1. Add Elapsed Time Counter
**File: `src/components/admin/ScrapeLogosDialog.tsx`**

Show a running timer so users know the process is active:
- Display "Elapsed: 0:45" next to "Processing batch 1..."
- Timer updates every second while processing

### 2. Add Spinning Indicator
Add a visible spinner next to the progress text to indicate active work.

### 3. Add Estimated Time Message
Show informative text like:
> "Each location takes 15-30 seconds to process. Batch of 10 may take up to 5 minutes."

### 4. Use Smaller Default Batch Size
Change default from 10 to 5 so users see results faster (feedback every 1.5-2 minutes instead of 3-5 minutes).

---

## Implementation Details

Add state for tracking elapsed time:
```text
const [elapsedSeconds, setElapsedSeconds] = useState(0);

useEffect(() => {
  if (!processing) {
    setElapsedSeconds(0);
    return;
  }
  const interval = setInterval(() => {
    setElapsedSeconds(s => s + 1);
  }, 1000);
  return () => clearInterval(interval);
}, [processing]);
```

Update progress section to show:
```text
Processing batch 1... (Elapsed: 1:23)        0%
[====                                          ]
Each location takes 15-30 seconds. This batch may take a few minutes.
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/admin/ScrapeLogosDialog.tsx` | Add elapsed timer, spinner, informative text, change default batch to 5 |

---

## Result
- Users will see an actively ticking timer showing the process is running
- Informative text sets correct expectations about timing
- Smaller default batch means faster initial feedback
- Spinner provides visual indication of activity

