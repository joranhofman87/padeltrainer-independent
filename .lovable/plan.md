

# Rating Chart — Clean Up + Best Rating + Shareable Download

## Changes

### `src/components/player/RatingHistoryChart.tsx`

1. **Add "Best" rating to stats row** — compute the best rating (min for lower-is-better, max otherwise) and show it as a 4th stat or replace the "Started" stat with a "Best" highlight on the left side of the card. Since 4 columns gets cramped on mobile, add a prominent best rating display on the left side above the stats row — a large number with "Best rating" label.

2. **Remove bottom text** — delete the footer with "lower rating = better" note and "updated every 15th" text (lines 311-320).

3. **Simplify share button** — replace the dropdown with a single "Download image" button (no share/copy link). Remove the `DropdownMenu` import and related share logic.

4. **Make the downloaded image shareable** — the `toPng` capture already grabs the whole card. Add the PadelTrainer.ai logo inside the card (visible in the exported image). Add a small logo + "PadelTrainer.ai" watermark at the bottom-right of the card content area so it appears in the PNG export. Use the existing `Logo` component or import the logo SVG directly.

5. **Best rating highlight** — show the best rating number prominently (large text) on the left side of the stats section, with a label like "Best" and the rating system name.

## Layout

```text
┌──────────────────────────────────────────────┐
│ 📈 Rating Progress (KNLTB)    [📥 Download] │
│ Tracking your improvement                    │
│                                              │
│ ┌─Started─┐ ┌─Current─┐ ┌─Best──┐ ┌─Change─┐│
│ │  8.0    │ │  4.2   │ │ 4.2  │ │ +3.8  ││
│ └────────┘ └────────┘ └──────┘ └───────┘│
│                                              │
│  [chart area]                                │
│                                              │
│                        padeltrainer.ai logo  │
└──────────────────────────────────────────────┘
```

Actually, 4 columns is tight on mobile. Better approach: keep 3 stats (Started / Current / Best) and move the improvement into the header area as a badge. Or: keep the 3-col grid but swap "Improvement" for "Best" and show improvement as a small badge next to "Current".

Final layout — keep it simple:
- **3-column stats**: Started | Current | Best
- **Improvement shown as a small badge** next to "Current" value (e.g. "+3.8" in green)
- **Single download button** (no dropdown)
- **Logo watermark** at bottom-right of card for PNG branding
- **No footer text**

## Files changed

| File | Change |
|------|--------|
| `src/components/player/RatingHistoryChart.tsx` | Add best rating stat, remove footer text, simplify to download-only button, add logo watermark for exports |

