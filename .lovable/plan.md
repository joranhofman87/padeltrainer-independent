
# Fix: "Connect Your Bank Account" card loading delay on Trainer Earnings

## Problem
The "Connect Your Bank Account" card appears later than the rest of the page because `connectStatus` starts as `null` and only gets set after the `checkConnectStatus()` edge function call resolves. The main page loading state (`loadingData`) only tracks the bookings fetch, so the page renders without the Mollie card, which then pops in once the status arrives.

## Solution
Add a dedicated loading state (`connectStatusLoading`) for the Mollie connect check, and render a Skeleton placeholder card in its place while loading. This prevents the layout shift and makes the page feel cohesive.

## Technical Details

### File: `src/pages/TrainerEarnings.tsx`

1. Add a new state variable `connectStatusLoading` (default `true`)
2. Set it to `false` at the end of `checkConnectStatus()` (in both success and error paths)
3. In the JSX, where the Mollie Connect card is rendered (around line 474), add a skeleton card that shows while `connectStatusLoading` is true and the trainer is not using manual invoicing or academy payments
4. Import `Skeleton` from `@/components/ui/skeleton`

The skeleton will match the approximate size of the "Connect Your Bank Account" card so there is no layout shift when the real content appears.
