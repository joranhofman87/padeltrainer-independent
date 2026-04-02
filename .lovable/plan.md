

# Rating History Chart — UI Polish + Share/Download

## Problems from screenshot
1. **X-axis is cluttered** — too many date labels crammed together ("Apr 1 Jun 1 Jul 1 Aug 1 Oct 1 Dec 1 Feb 1 Apr 1..."), overlapping and unreadable
2. **Chart too short** — `h-48` (192px) is cramped for 2+ years of data points
3. **Y-axis values are sparse** — hard to read the scale
4. **No share/download option** — players can't share their progress
5. **Dots on every data point** — with 20+ entries, every-dot rendering adds visual noise

## Changes

### 1. Clean up the chart (`src/components/player/RatingHistoryChart.tsx`)

- **Increase chart height** from `h-48` to `h-64` for breathing room
- **X-axis**: Format dates as `MMM ''yy` (e.g. "Jan '24") and add `interval="preserveStartEnd"` + `angle={-45}` with proper bottom margin so labels don't overlap
- **Hide dots** on the line by default (`dot={false}`), only show on hover via `activeDot`
- **Add gradient fill** under the line (using `<defs>` + `<LinearGradient>` + `<Area>`) for a modern, polished look — switch from `LineChart` to `AreaChart`
- **Smooth the line** with `type="monotone"` (already set) and increase stroke width slightly
- **Add padding** to Y-axis domain so the line doesn't touch edges

### 2. Share/Download button

Add a dropdown button in the card header with two options:
- **Download as PNG** — use `html-to-image` (already commonly available, or use the native canvas approach via recharts' `toDataURL` — but simplest is wrapping the card in a ref and using `html2canvas` pattern). Use `html-to-image`'s `toPng` to capture the entire card including stats.
- **Share** — use the Web Share API (`navigator.share`) when available (mobile), falling back to "Copy link" which copies the player's dashboard URL. This is SEO-friendly because it drives traffic back to the platform.

For SEO: The share generates a link to a public profile page (if exists) or the platform URL, not just an image. This drives backlinks.

### 3. Stats row refinement
- Use `font-mono` on the rating numbers for consistent alignment
- Show ratings to 1 decimal place consistently (e.g. "8.0" not "8")

## Files changed

| File | Change |
|------|--------|
| `src/components/player/RatingHistoryChart.tsx` | Major refactor: AreaChart with gradient, cleaned X-axis, taller chart, share/download dropdown, dot cleanup |
| `package.json` | Add `html-to-image` dependency for PNG export |

## Implementation detail

```text
┌─────────────────────────────────────────────┐
│ 📈 Rating Progress (KNLTB)     [↗ Share ▾] │
│ Tracking your padel improvement over time   │
│                                              │
│ ┌─ Started ─┐ ┌─ Current ─┐ ┌─ Change ──┐  │
│ │    8.0     │ │    4.2    │ │   +3.8    │  │
│ └───────────┘ └──────────┘ └───────────┘  │
│                                              │
│  ▲                                    ╱──   │
│  │                              ╱────╱      │
│  │                    ╱────────╱             │
│  │        ╱──────────╱                       │
│  │  ╱────╱   (gradient fill underneath)      │
│  └──────────────────────────────────────▶   │
│   Jan'23  Jul'23  Jan'24  Jul'24  Jan'25    │
│                                              │
│  ℹ Lower = better · Updated monthly         │
└─────────────────────────────────────────────┘
```

The share dropdown:
- "Download as image" → captures the card as PNG
- "Share progress" → Web Share API on mobile, copy-link fallback on desktop

