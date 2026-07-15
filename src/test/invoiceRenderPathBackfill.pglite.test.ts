// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Theme B / B1: the invoice render_path backfill must be conservative — it feeds the storage GC
// (which deletes every object matching NO invoice's render_path), and forward-invoice downloads
// whatever path the row claims. Runs the REAL migration against Postgres with a mocked
// storage.objects and proves:
//   pass 1: stamps the derived path ONLY when that object actually exists (trainer + academy);
//   pass 2: rescues a deleted-trainer render under an old folder via unambiguous number match;
//   ambiguity guards: cross-tenant duplicate numbers (both directions) and objects already
//   claimed by pass 1 are never stamped — wrong cross-tenant matches would email tenant B's PDF
//   for tenant A's invoice and let the GC reap real renders.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TUSER = 'aa000000-0000-0000-0000-0000000000a0';
const T_LIVE = 'aa000000-0000-0000-0000-0000000000a1'; // live trainer (user_id set)
const T_SHELL = 'bb000000-0000-0000-0000-0000000000b1'; // deleted trainer (anonymized shell, user_id NULL)
const OLD_SHELL_USER = 'bb000000-0000-0000-0000-0000000000b0'; // folder the shell's renders were uploaded under
const ACAD = 'cc000000-0000-0000-0000-0000000000c1';

const INV_LIVE = 'd0000000-0000-0000-0000-000000000001'; // pass 1: trainer folder object exists
const INV_NOOBJ = 'd0000000-0000-0000-0000-000000000002'; // pass 1 skip: no object → NULL
const INV_ACAD = 'd0000000-0000-0000-0000-000000000003'; // pass 1: academy folder object exists
const INV_SHELL = 'd0000000-0000-0000-0000-000000000004'; // pass 2: old-folder object, unique number
const INV_DUP_A = 'd0000000-0000-0000-0000-000000000005'; // ambiguity: same number as INV_DUP_B, ONE object
const INV_DUP_B = 'd0000000-0000-0000-0000-000000000006';
const INV_CLAIMED = 'd0000000-0000-0000-0000-000000000007'; // shares INV_LIVE's number; its only match is pass-1-claimed

const renderPath = async (id: string): Promise<string | null> => {
  const { rows } = await db.query<{ render_path: string | null }>(
    `SELECT render_path FROM public.invoices WHERE id = $1`, [id],
  );
  return rows[0].render_path;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY,
      trainer_id uuid,
      academy_profile_id uuid,
      invoice_number text
    );

    INSERT INTO public.trainer_profiles (id, user_id) VALUES
      ('${T_LIVE}', '${TUSER}'),
      ('${T_SHELL}', NULL); -- anonymized shell: derivation can no longer find its folder

    INSERT INTO public.invoices (id, trainer_id, academy_profile_id, invoice_number) VALUES
      ('${INV_LIVE}',    '${T_LIVE}',  NULL,      'INV-001'),
      ('${INV_NOOBJ}',   '${T_LIVE}',  NULL,      'INV-002'),
      ('${INV_ACAD}',    NULL,         '${ACAD}', 'ACA-001'),
      ('${INV_SHELL}',   '${T_SHELL}', NULL,      'SHL-001'),
      ('${INV_DUP_A}',   '${T_LIVE}',  NULL,      'DUP-001'),
      ('${INV_DUP_B}',   NULL,         '${ACAD}', 'DUP-001'),
      ('${INV_CLAIMED}', '${T_SHELL}', NULL,      'INV-001'); -- same number as INV_LIVE, no own object

    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('invoices', '${TUSER}/INV-001.pdf'),          -- INV_LIVE's render (expected path)
      ('invoices', '${ACAD}/ACA-001.pdf'),           -- INV_ACAD's render (expected path)
      ('invoices', '${OLD_SHELL_USER}/SHL-001.pdf'), -- INV_SHELL's render under the OLD folder
      ('invoices', '${OLD_SHELL_USER}/DUP-001.pdf'), -- one object, TWO invoices numbered DUP-001
      ('avatars',  '${TUSER}/INV-002.pdf');          -- wrong bucket: must never satisfy INV_NOOBJ
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826150000_b1_invoice_render_path.sql'),
      'utf8',
    ),
  );
});

describe('invoice render_path backfill (B1)', () => {
  it('pass 1 stamps the derived trainer path when the object exists', async () => {
    expect(await renderPath(INV_LIVE)).toBe(`${TUSER}/INV-001`);
  });

  it('pass 1 stamps the derived academy path when the object exists', async () => {
    expect(await renderPath(INV_ACAD)).toBe(`${ACAD}/ACA-001`);
  });

  it('leaves NULL when no object exists (never claims a path that is not there)', async () => {
    expect(await renderPath(INV_NOOBJ)).toBeNull();
  });

  it("pass 2 rescues a deleted-trainer render under its OLD folder via unambiguous number match", async () => {
    expect(await renderPath(INV_SHELL)).toBe(`${OLD_SHELL_USER}/SHL-001`);
  });

  it('ambiguity guard: one object matching TWO invoices with the same number stamps NEITHER', async () => {
    expect(await renderPath(INV_DUP_A)).toBeNull();
    expect(await renderPath(INV_DUP_B)).toBeNull();
  });

  it('claimed guard: an object already stamped by pass 1 is never re-assigned by pass 2', async () => {
    // INV_CLAIMED shares INV_LIVE's number; its only LIKE match is INV_LIVE's render — must stay NULL.
    expect(await renderPath(INV_CLAIMED)).toBeNull();
  });
});
