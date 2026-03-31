

# Edit Registrations & Player Linking System

## Summary
Two features for the intake requests (aanmeldingen) system:

1. **Edit registrations** — Trainers and academy managers can edit any field of a registration from the detail sheet.
2. **Link players together** — Simply connect 2+ registrations so they stay together during proposal generation. No group names, no extra metadata — just links between registrations within the same cycle.

No existing data is modified. Only new capabilities and a new table are added.

## Database Changes

### New table: `player_links`

A simple join table that groups registrations together. Registrations sharing the same `link_group` UUID belong together.

```sql
CREATE TABLE public.player_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_group uuid NOT NULL DEFAULT gen_random_uuid(),
  intake_request_id uuid NOT NULL REFERENCES intake_requests(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intake_request_id)
);
```

- Each registration can belong to at most one link group
- Registrations with the same `link_group` value want to train together
- No name column — purely structural linking

RLS policies mirror existing intake_requests policies (trainers for their cycles, academy managers for their academy's cycles).

## Application Changes

### 1. Edit Registration

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `updateIntakeRequest(id, fields)` function |
| `src/components/cycles/EditIntakeRequestDialog.tsx` | New dialog with form pre-populated with current data (name, email, phone, rating, lesson type, days, time windows, duration, sessions/week, trainers, notes) |
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Add "Edit" (Pencil) button that opens the edit dialog |

### 2. Link Players Together

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `getPlayerLinks(cycleId)`, `linkPlayers(intakeRequestIds)`, `unlinkPlayer(intakeRequestId)` functions |
| `src/components/cycles/IntakeRequestsTable.tsx` | Add a colored "link" badge/icon showing linked registrations. Add checkbox selection + "Link selected" button. Show which players are linked together using matching colored dots/icons. |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Pass link data to table, wire up link/unlink actions |
| `src/pages/TrainerIntakeRequests.tsx` | Same integration |

**Linking flow:**
1. Select 2+ registrations using checkboxes in the table
2. Click "Link together" button
3. All selected registrations get the same `link_group` UUID
4. Linked registrations show a matching colored indicator in the table
5. Click the link icon on any linked registration to unlink it

### 3. Proposal Generator Update

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Fetch `player_links` for the cycle. When placing a player that has a link group, heavily boost score for slots where other linked players are already placed. Process linked players consecutively. |

The group cohesion score is additive — it does not override time/availability matching, it just strongly favors keeping linked players in the same slot.

### 4. Translation Keys
Add Dutch translations for link-related UI labels and messages.

## Safety
- No changes to existing `intake_requests` schema
- No existing data modified — only INSERTs into the new `player_links` table
- Cycles without any links work exactly as before
- Edit only updates fields the admin explicitly changes

