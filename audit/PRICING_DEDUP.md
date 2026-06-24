# Registration-pricing dedup — map, the bug it hid, and the remaining work

The pre-scale audit flagged registration-pricing/invoice logic duplicated between the Vite
frontend (`src/`) and the Deno edge functions (`supabase/functions/`). Investigating it
surfaced a real **money bug** (now fixed) and a residual code-level dedup (scoped below).

## The bug (FIXED)
The cycle's fallback lesson count (no package, no duration allow-list) is the whole-week date
span. Three places computed it; one disagreed:

| Place | How | Result for a 10-week + 4-day span |
|---|---|---|
| Cycle editor (`CycleForm.tsx`) | `differenceInWeeks` (truncates) | **10** |
| Registration form preview (`CycleApplicationForm.tsx`) | `Math.floor(span/7d)` | **10** |
| Server `dateSpanWeeks` (`_shared/registration-pricing.ts`) | ~~`Math.round`~~ → **`Math.floor`** | was **11**, now **10** |

The server's `Math.round` **over-charged a non-exact-week date-span cycle by one lesson** — the
invoice + confirmation email billed 11 where the academy configured (and the registrant saw) 10.
Fixed by flooring (regression test in `src/test/registrationPricing.test.ts`). ⚠️ This **lowers**
the charge for affected cycles — owner should redeploy the registration edge fns (below).

## Duplication map (for the eventual code dedup)
`supabase/functions/_shared/registration-pricing.ts` is **pure, import-free TS** — both Deno and
Vite (and the existing tests) can import it. Genuinely duplicated:
- **Lesson-count resolution** — `resolveRegistrationLessonCount` (server, authoritative) vs the
  inline calc in `CycleApplicationForm.tsx` (~L947). Same intent; the server additionally
  validates selections against the cycle's allow-lists.
- **Per-lesson price lookup** (price_table / cyclus_options) — server `computeRegistrationCharge`
  vs the inline form loop (~L962-988).
- **VAT math** — server `computeRegistrationCharge` vs frontend `src/lib/invoiceCalc.ts`
  `calculateVatTotals` (byte-identical intent), plus `round2` in both.

Frontend-only (no dedup needed): `bookingPricing.ts`, `invoiceSplitPricing.ts`, and the
booking/extra-cost line builder in `invoiceCalc.ts` (different domain — rebooking/split UI).

## Remaining work (scoped follow-up — deliberately NOT done in the bug-fix PR)
Make `CycleApplicationForm.tsx` import `resolveRegistrationLessonCount` (and ideally
`computeRegistrationCharge`) from the shared module instead of recomputing inline → one source
of truth, no future drift. Two things to resolve first, which is why it's separate:
1. **Build config**: the import crosses the `src/` ↔ `supabase/functions/` boundary with a
   `.ts` extension. Tests already do this (vitest/esbuild is lenient); confirm the production
   `vite build` (rollup + app tsconfig) accepts it, or add a thin `src/lib/` re-export.
2. **Behavior alignment**: the shared fn validates `durationWeeks`/`cyclusOptionLabel` against the
   cycle's allow-lists; the form uses already-validated UI state. Swapping aligns the preview to
   the server (correct) but is a visible money-display change in edge cases — verify on a few real
   cycles before shipping.

## Owner deploy (for the bug fix)
The floor fix lives in `_shared/registration-pricing.ts`, used by these edge fns — redeploy:
```
supabase functions deploy submit-guest-intake create-registration-invoice --project-ref ficwbdrzefmblkbkomzw
```
(`_shared/event-registration-invoice.ts` + `_shared/registration-confirmation-email.ts` import it,
so any fn bundling those is covered by redeploying the two above.)
