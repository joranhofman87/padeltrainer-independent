

# Fix: Proposals data inconsistent — 71 "proposed" requests but no slots or assignments

## What happened
Your cycle has 71 intake requests with status `proposed`, but **zero** availability slots and **zero** proposed assignments in the database. This is an inconsistent state — the proposals were partially deleted (slots + assignments removed) but the intake request statuses were never reset back to `new`.

This likely happened during an earlier session where the connection timed out mid-reset (during the DB overload period), or the slots were deleted through a different code path that didn't update the intake request statuses.

## Immediate fix: Reset the data
Click the **Reset** button on Step 4. This will:
- Set all 71 intake requests back to `new`
- Delete any remaining proposed assignments (there are none, but it cleans up safely)
- Take you back to Step 3 (Generate) where you can re-create slots and re-generate proposals

This should work — the `resetProposals` function handles exactly this case.

## Code improvement: Make reset more resilient
To prevent this inconsistent state in the future, I'll add a safeguard: when `getAvailableSlotsForCycle` detects that intake requests are `proposed` but no assignments exist, it auto-corrects them back to `new`.

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | In `getAvailableSlotsForCycle`, after fetching assignments: if slots are empty and assignments are empty but proposed intake requests exist, auto-reset those intake request statuses to `new` |

## Steps
1. **Try the Reset button now** — it should clear the inconsistent state and let you re-generate
2. After that works, I'll add the safeguard code to auto-heal this state if it ever happens again

