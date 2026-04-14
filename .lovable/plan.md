

# Fix PDF Invoice: Logo, Spacing, and Totals Formatting

## Problems (from screenshot)

1. **Logo missing** — Shows "RL Padel Performance" text instead of the actual logo. The logo embedding code exists but likely fails because the uploaded logo is an SVG file, and `pdf-lib` only supports PNG/JPG embedding. The error is caught silently and falls back to text.

2. **No padding between header bar and "FACTUUR"** — Currently `y = height - 70`, giving only 20pt gap below the 50pt header. Needs ~40pt of breathing room.

3. **No padding between "FACTUUR" and from/to section** — `y -= 55` after FACTUUR title is tight.

4. **No padding between from/to and table** — `y = Math.min(yLeft, yRight) - 20` only gives 20pt gap.

5. **Totals formatting inconsistent with table** — Table rows use font size 9, but totals use size 10 (regular) and 12 (bold total). The totals should use size 9 to match, with only the final "Totaal" row slightly larger.

## Solution

### File: `supabase/functions/generate-invoice/index.ts`

**A) Fix logo embedding for SVG logos**
- Before trying to embed, check if the content-type is SVG or the URL ends with `.svg`
- For SVG logos, skip embedding (pdf-lib cannot handle SVG) and fall back to text
- Log a clear message so we know when SVG is the issue
- This keeps existing PNG/JPG support working

**B) Increase vertical spacing between sections**
- Header → FACTUUR: change `y = height - 70` to `y = height - 100` (50pt gap below header)
- FACTUUR → from/to: change `y -= 55` to `y -= 65`
- From/to → table: change gap from 20pt to 30pt: `Math.min(yLeft, yRight) - 30`

**C) Match totals formatting to table**
- Change `drawTotalRow` default size from 10 to 9 (matching table cell font size)
- Change bold total size from 12 to 10
- Keep right-alignment logic as-is since it already matches the table's amount column

### Deploy
Redeploy `generate-invoice` after changes.

## File Summary

| File | Change |
|---|---|
| `supabase/functions/generate-invoice/index.ts` | SVG logo detection, increase section spacing, match totals font size to table |

