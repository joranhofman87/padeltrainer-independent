

## Remove "Your Skill Rating" Banner from Player Dashboard

### What
Remove the blue gradient "Your Skill Rating" card (lines 300-325) from `src/pages/PlayerDashboard.tsx`. The Rating History Chart below it already displays the current rating and progress, making the banner redundant.

### Changes

**File: `src/pages/PlayerDashboard.tsx`**

Remove the entire Rating Card block (lines 300-325):
```
{/* Rating Card */}
<Card className="mb-8 bg-gradient-to-r from-blue-500 to-blue-600 ...">
  ...
</Card>
```

The `RatingHistoryChart` component (lines 327-336) remains and continues to show the player's current rating and progress over time.

### Cleanup
- The `TrendingUp` icon import can be removed if it's no longer used elsewhere in the file.

