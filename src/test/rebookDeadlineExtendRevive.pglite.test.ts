// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Extend-after-lapse for the editable rebook deadline (rebookRoundDeadline.ts): a round whose
// priority window already passed has its pending claims stamped 'expired' by the */15 cron.
// Moving the deadline into the future + reviving expired claims (the lib's two UPDATE
// statements, applied slots-first) must (1) let revived invitees respond again and (2) leave
// the real expire cron (migration 20260725100000) with NOTHING to re-expire — while genuine
// declines stay declined and claimed seats stay claimed.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const S = '50000000-0000-0000-0000-000000000001'; // slot, priority window lapsed yesterday
const S_REL = '50000000-0000-0000-0000-000000000002'; // slot the academy RELEASED — excluded

const status = async (token: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token=$1`, [token]))
    .rows[0]?.status;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, priority_window_ends_at timestamptz,
      member_window_starts_at timestamptz, member_window_ends_at timestamptz,
      public_release_status text);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      rebook_group_id uuid, claim_token text, responded_at timestamptz, response_intent text);

    -- Lapsed round: priority ended yesterday, member window still open until tomorrow.
    INSERT INTO public.availability_slots VALUES
      ('${S}', now() - interval '1 day', now() - interval '1 day', now() + interval '1 day', 'auto_release_scheduled'),
      ('${S_REL}', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'released');
    INSERT INTO public.slot_priority_claims (slot_id, status, claim_token, responded_at, response_intent) VALUES
      ('${S}', 'expired',  'lapsed-silent',  now() - interval '20 hours', NULL),      -- cron-expired, never answered → revive
      ('${S}', 'expired',  'lapsed-decline', now() - interval '20 hours', 'decline'), -- expired with a recorded "no" → revives, still reads declined
      ('${S}', 'declined', 'said-no',        now() - interval '2 days',   'decline'), -- genuine decline → NEVER revived
      ('${S}', 'claimed',  'kept-seat',      now() - interval '2 days',   'accept'),  -- kept seat → untouched
      ('${S_REL}', 'expired', 'on-released', now() - interval '20 hours', NULL);      -- released slot → NOT revived
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260725100000_protect_paid_group_from_expiry.sql'), 'utf8'));
});

describe('deadline extension + revival vs the real expire cron', () => {
  it('extends non-released slots, revives their expired claims, and the cron re-expires nothing', async () => {
    // The lib's statement 1 (slots first — computeWindowTargets output for the non-released slot):
    await db.exec(`
      UPDATE public.availability_slots
      SET priority_window_ends_at = now() + interval '7 days',
          member_window_starts_at = now() + interval '7 days',
          member_window_ends_at   = now() + interval '9 days'
      WHERE id = '${S}';
    `);
    // Statement 2 (revive expired claims of the UPDATED slots only):
    const revived = await db.query<{ id: string }>(`
      UPDATE public.slot_priority_claims SET status = 'pending', responded_at = NULL
      WHERE slot_id = '${S}' AND status = 'expired' RETURNING id;
    `);
    expect(revived.rows).toHaveLength(2); // lapsed-silent + lapsed-decline

    // The REAL cron finds nothing to expire: the revived claims sit behind a future deadline,
    // and the released slot has no pending claims.
    const expired = (await db.query<{ n: number }>(`SELECT public.expire_lapsed_priority_claims() AS n`)).rows[0].n;
    expect(Number(expired)).toBe(0);

    expect(await status('lapsed-silent')).toBe('pending'); // can respond via their existing link
    expect(await status('lapsed-decline')).toBe('pending'); // status revived; decline INTENT still reads "declined" in the UI
    expect(await status('said-no')).toBe('declined'); // genuine declines never resurrect
    expect(await status('kept-seat')).toBe('claimed'); // untouched
    expect(await status('on-released')).toBe('expired'); // released slot excluded from revival
  });
});
