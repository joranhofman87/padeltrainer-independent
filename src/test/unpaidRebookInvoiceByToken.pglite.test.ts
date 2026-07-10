// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Resume-payment RPC (migration 20260802100000): get_unpaid_rebook_invoice_by_claim_token must return
// ONLY the claim's own active, unpaid, non-revoked rebook invoice pay token — single-claim invoices
// matched by (rebook_cyclus_id + claimant identity), group invoices by rebook_group_id — and must
// never leak another claimant's invoice. Runs the real SECURITY DEFINER function against Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CY1 = 'c1000000-0000-0000-0000-000000000001';
const S1 = '51000000-0000-0000-0000-000000000001';
const PA = 'aa000000-0000-0000-0000-000000000001';
const PB = 'bb000000-0000-0000-0000-000000000001';
const PC = 'cc000000-0000-0000-0000-000000000001';
const GG = 'dd000000-0000-0000-0000-000000000001'; // guest captain
const G1 = 'e1000000-0000-0000-0000-000000000001';
const TOK_A = '11110000-0000-0000-0000-000000000001';
const TOK_G = '22220000-0000-0000-0000-000000000001';

const resolve = async (token: string) =>
  (await db.query<{ r: { public_token?: string; status?: string } | null }>(
    `SELECT public.get_unpaid_rebook_invoice_by_claim_token($1) AS r`, [token])).rows[0].r;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, cyclus_id uuid);
    CREATE TABLE public.slot_priority_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, status text,
      rebook_group_id uuid, claim_token text, player_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rebook_group_id uuid, rebook_cyclus_id uuid,
      player_id uuid, guest_player_id uuid, status text, public_token uuid,
      public_token_revoked_at timestamptz, created_at timestamptz DEFAULT now());

    INSERT INTO public.availability_slots VALUES ('${S1}', '${CY1}');
    INSERT INTO public.slot_priority_claims (slot_id, status, rebook_group_id, claim_token, player_id, guest_player_id) VALUES
      ('${S1}', 'claimed', NULL,    'tokA',    '${PA}', NULL),   -- single, has an unpaid invoice
      ('${S1}', 'claimed', NULL,    'tokPaid', '${PB}', NULL),   -- single, invoice already paid
      ('${S1}', 'claimed', NULL,    'tokC',    '${PC}', NULL),   -- single, NO invoice for this identity
      ('${S1}', 'claimed', '${G1}', 'tokG',    NULL,    '${GG}'),-- group captain, unpaid group invoice
      ('${S1}', 'pending', '${G1}', 'tokMate', '${PC}', NULL);   -- group TEAMMATE (not the invoice recipient)

    INSERT INTO public.invoices (rebook_group_id, rebook_cyclus_id, player_id, guest_player_id, status, public_token, public_token_revoked_at) VALUES
      (NULL,    '${CY1}', '${PA}', NULL,    'sent', '${TOK_A}',          NULL),  -- INV_A: PA unpaid
      (NULL,    '${CY1}', '${PB}', NULL,    'paid', gen_random_uuid(),   NULL),  -- INV_B: PB paid (excluded)
      ('${G1}', NULL,     NULL,    '${GG}', 'open', '${TOK_G}',          NULL),  -- INV_G: group unpaid
      (NULL,    '${CY1}', '${PA}', NULL,    'sent', gen_random_uuid(),   now()); -- INV_A2: PA but token revoked
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260802100000_unpaid_rebook_invoice_by_token.sql'), 'utf8'));
  // Apply the redefinition in prod migration order — the group branch is now captain-scoped.
  // (Loads only the resume-RPC half; get_rebook_group_by_token has its own suite + schema.)
  const combined = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260803100100_group_token_paid_state.sql'), 'utf8');
  const resumeHalf = combined.slice(combined.indexOf('CREATE OR REPLACE FUNCTION public.get_unpaid_rebook_invoice_by_claim_token'));
  await db.exec(resumeHalf);
});

describe('get_unpaid_rebook_invoice_by_claim_token', () => {
  it("returns the claimant's active unpaid single invoice token", async () => {
    expect((await resolve('tokA'))?.public_token).toBe(TOK_A); // never the revoked sibling
  });

  it('returns null when the only cyclus invoice is already paid', async () => {
    expect(await resolve('tokPaid')).toBeNull();
  });

  it("does NOT leak another claimant's invoice (identity isolation)", async () => {
    // PC has a claim in CY1 but no invoice of their own; PA's invoice must not surface.
    expect(await resolve('tokC')).toBeNull();
  });

  it('returns the group invoice token for a group captain claim', async () => {
    expect((await resolve('tokG'))?.public_token).toBe(TOK_G);
  });

  it("does NOT hand a teammate the captain's group invoice (captain-scoped)", async () => {
    // tokMate is in the same group but is not the invoice recipient — no resume banner for them.
    expect(await resolve('tokMate')).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await resolve('nope')).toBeNull();
  });
});
