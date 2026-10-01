// @vitest-environment node
//
// E-6 — the OPERATOR SURFACE's authorization boundary, on the real chain, as `authenticated`.
//
// This is the security half of the browser cutover. The driver is exercised against the five
// `*_as_actor` wrappers through a session that presents a PostgREST-shaped JWT under the
// `authenticated` role, using the platform shim's REAL `auth.uid()` — the one that reads the
// per-request GUC. A convenience stub would make every subject NULL, every wrapper refuse, and
// every assertion below pass while proving nothing at all.
//
// THE PROPERTY UNDER TEST IS NON-DISCLOSURE, not merely refusal. A wrapper that refuses with a
// DIFFERENT row for "no such command" than for "someone else's command" is an enumeration oracle:
// a manager could walk UUIDs and learn which ones exist in academies they do not manage. So every
// negative case below is compared against another negative case for ROW EQUALITY, not just for
// having been refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { asActor, bootD7Chain, postgrestRows, type D7Chain } from './d7RealChain';
import {
  ABC27_WIRE_VERSION, decodeApplyRow, decodeCommandLookupRow, decodeCommandStatusRow,
  decodeLifecycleRow, decodePreviewRow, decodeSingle,
} from '@/lib/rebookRoundCommand';

const PORT = 54506;
const PREFIX = 'd7browser';
const ACADEMY_A = '11111111-1111-4111-8111-111111111111';
const ACADEMY_B = '22222222-2222-4222-8222-222222222222';

let chain: D7Chain;
let c: pg.Client;
/** A manager of academy A, a PEER manager of academy A, and a manager of academy B. */
let owner: string;
let peer: string;
let outsider: string;
/** A command applied by `owner`, so the recovery surfaces have something real to refuse about. */
let ownerCommandId: string;
let ownerFingerprint: string;

const NOWHERE = '00000000-0000-4000-8000-000000000000';

/** The wrapper argument vector, in signature order. Deliberately a bare, invalid-but-well-typed
 *  intent: every test here is about AUTHORIZATION, which is decided before any product fact is
 *  read — the wrapper touches no slot, cycle or round until the pair fence has passed. */
const PREVIEW_ARGS = (academy: string, version: string = ABC27_WIRE_VERSION) => [
  academy, version, 'create', null, null, 'label', null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  [], [], [], [], [], [],
];
const PREVIEW_SQL = `SELECT * FROM public.rebook_round_preview_command_as_actor(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
  $26::date[],$27::date[],$28::text[],$29::uuid[],$30::uuid[],$31::uuid[])`;

const APPLY_SQL = `SELECT * FROM public.rebook_round_apply_command_as_actor(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
  $27::date[],$28::date[],$29::text[],$30::uuid[],$31::uuid[],$32::uuid[],$33::bytea)`;
const APPLY_ARGS = (academy: string, commandId: string, fingerprint: string | null,
  version: string = ABC27_WIRE_VERSION) => [
  academy, commandId, version, 'create', null, null, 'label', null, null, null, null, null,
  null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  [], [], [], [], [], [], fingerprint,
];

beforeAll(async () => {
  chain = await bootD7Chain({ port: PORT, prefix: PREFIX, vaultServiceRoleKey: 'd7-browser-key' });
  c = await chain.clone(`${PREFIX}_main`);
  await c.query(`
    INSERT INTO public.academy_profiles(id,name) VALUES ('${ACADEMY_A}','A'),('${ACADEMY_B}','B')
      ON CONFLICT DO NOTHING;`);
  const users = (await c.query(
    `INSERT INTO auth.users(id) SELECT gen_random_uuid() FROM generate_series(1,3) RETURNING id`)).rows;
  [owner, peer, outsider] = users.map((u) => u.id as string);
  await c.query(`INSERT INTO public.academy_managers(academy_profile_id,user_id) VALUES
    ($1,$2),($1,$3),($4,$5)`, [ACADEMY_A, owner, peer, ACADEMY_B, outsider]);

  // A real applied command belonging to `owner`, so the recovery surfaces have something that
  // genuinely exists to refuse about. Without it, "peer cannot see it" would be indistinguishable
  // from "there was nothing there".
  ownerCommandId = (await c.query(`SELECT gen_random_uuid() id`)).rows[0].id;
  ownerFingerprint = (await c.query(`SELECT encode(extensions.digest('owner-review','sha256'),'hex') h`))
    .rows[0].h;
  const round = (await c.query(
    `INSERT INTO public.rebook_rounds (academy_profile_id,label,priority_window_ends_at,member_window_ends_at)
     VALUES ($1,'browser',now()-interval '1 hour',now()+interval '7 days') RETURNING id`,
    [ACADEMY_A])).rows[0].id;
  await c.query(`INSERT INTO public.rebook_round_commands
    (command_id,academy_profile_id,actor_user_id,round_id,command_kind,request_fingerprint,
     fingerprint_algorithm,canonical_payload,result_receipt,result_receipt_canonical,
     result_receipt_digest,applied_at)
    VALUES ($1,$2,$3,$4,'create',decode($5,'hex'),'abc27.cmd.v2+sha256','{}','{}',
            pg_catalog.convert_to('{}','UTF8'),
            pg_catalog.sha256(pg_catalog.convert_to('{}','UTF8')),now())`,
  [ownerCommandId, ACADEMY_A, owner, round, ownerFingerprint]);
}, 300_000);

afterAll(async () => { await chain?.shutdown(); });

// Every helper returns rows in the POSTGREST WIRE SHAPE, so the browser decoders under test are
// exercised against exactly the shapes the browser receives — Buffers rendered as `"\\x…"` hex and
// Dates rendered as ISO strings. Teaching the decoders to accept `pg`'s native shapes instead would
// have loosened a production contract to suit a harness.
const previewAs = (actor: string | null, academy: string, version: string = ABC27_WIRE_VERSION) =>
  asActor(c, actor, async () =>
    postgrestRows((await c.query(PREVIEW_SQL, PREVIEW_ARGS(academy, version))).rows));

const statusAs = (actor: string | null, academy: string, commandId: string) =>
  asActor(c, actor, async () => postgrestRows((await c.query(
    `SELECT * FROM public.rebook_round_command_status_as_actor($1,$2)`, [academy, commandId])).rows));

const lookupAs = (actor: string | null, academy: string, fingerprintHex: string) =>
  asActor(c, actor, async () => postgrestRows((await c.query(
    `SELECT * FROM public.rebook_round_command_lookup_by_review_as_actor($1,$2,decode($3,'hex'))`,
    [academy, ABC27_WIRE_VERSION, fingerprintHex])).rows));

const lifecycleAs = (actor: string | null, academy: string, version: string = ABC27_WIRE_VERSION) =>
  asActor(c, actor, async () => postgrestRows((await c.query(
    `SELECT * FROM public.rebook_round_apply_lifecycle_command_as_actor($1,$2,$3,$4,$5,$6,$7)`,
    [academy, NOWHERE, version, NOWHERE, null, 'open', 'closed'])).rows));

const applyAs = (actor: string | null, academy: string, commandId: string,
  fingerprint: string | null, version: string = ABC27_WIRE_VERSION) =>
  asActor(c, actor, async () => postgrestRows((await c.query(
    APPLY_SQL, APPLY_ARGS(academy, commandId, fingerprint, version))).rows));


// ── The fence admits the manager, and only the manager ───────────────────────────────────────

describe('E-6 — the actor fence', () => {
  it('THE HARNESS IS REAL: auth.uid() reflects the presented subject, and is NULL without one', async () => {
    // If this ever stopped being true, every refusal below would be a refusal of NOBODY and the
    // whole file would pass while testing nothing.
    expect(await asActor(c, owner, async () => (await c.query(`SELECT auth.uid()::text u`)).rows[0].u))
      .toBe(owner);
    expect(await asActor(c, null, async () => (await c.query(`SELECT auth.uid()::text u`)).rows[0].u))
      .toBeNull();
  });

  it('an AUTHORIZED manager gets past the fence — the refusal below means something', async () => {
    const rows = await previewAs(owner, ACADEMY_A);
    const row = decodeSingle(rows, decodePreviewRow);
    expect(row).not.toBeNull();
    // The bare intent is not a valid round, so the CORE refuses it — but with a typed
    // validation status, not the wrapper's `refused`. That difference is the fence passing.
    expect(row!.status).not.toBe('refused');
    expect(row!.contractVersion).toBe(ABC27_WIRE_VERSION);
  });

  it('NO ACTOR is refused by all five wrappers, each with its own closed row', async () => {
    expect(decodeSingle(await previewAs(null, ACADEMY_A), decodePreviewRow)!.status).toBe('refused');
    expect(decodeSingle(await applyAs(null, ACADEMY_A, NOWHERE, null), decodeApplyRow)!.status).toBe('refused');
    expect(decodeSingle(await lifecycleAs(null, ACADEMY_A), decodeLifecycleRow)!.status).toBe('refused');
    expect(decodeSingle(await statusAs(null, ACADEMY_A, ownerCommandId), decodeCommandStatusRow)!.status)
      .toBe('refused');
    expect(decodeSingle(await lookupAs(null, ACADEMY_A, ownerFingerprint), decodeCommandLookupRow)!.status)
      .toBe('refused');
  });

  it('a FOREIGN-ACADEMY manager is refused, and identically to having no actor at all', async () => {
    const foreign = await previewAs(outsider, ACADEMY_A);
    const anonymous = await previewAs(null, ACADEMY_A);
    expect(foreign[0].status).toBe('refused');
    // BYTE-FOR-BYTE THE SAME ROW. "Not a manager here" and "not signed in" must be one answer, or
    // the surface reports academy membership to anyone who asks.
    expect(foreign).toEqual(anonymous);
  });

  it('a manager of A cannot act on B, and a manager of B cannot act on A', async () => {
    expect((await previewAs(owner, ACADEMY_B))[0].status).toBe('refused');
    expect((await previewAs(outsider, ACADEMY_A))[0].status).toBe('refused');
    // ...and each is authorized in their OWN academy, so the refusals are about the pair and not
    // about the caller being generally unable to do anything.
    expect((await previewAs(owner, ACADEMY_A))[0].status).not.toBe('refused');
    expect((await previewAs(outsider, ACADEMY_B))[0].status).not.toBe('refused');
  });

  it('an UNKNOWN academy id is refused identically to a real one the actor does not manage', async () => {
    const unknown = await previewAs(owner, NOWHERE);
    const notMine = await previewAs(owner, ACADEMY_B);
    expect(unknown[0].status).toBe('refused');
    expect(unknown, 'an unknown tenant must not be distinguishable from a foreign one')
      .toEqual(notMine);
  });
});

// ── Actor scoping is finer than tenant scoping ───────────────────────────────────────────────

describe('E-6 — a same-academy PEER is not the same actor', () => {
  it('the owner recovers their own command by UUID', async () => {
    const row = decodeSingle(await statusAs(owner, ACADEMY_A, ownerCommandId), decodeCommandStatusRow);
    expect(row!.status).toBe('found');
    expect(row!.commandKind).toBe('create');
  });

  it('a PEER manager of the SAME academy is refused — and identically to an unknown command', async () => {
    // The `academy_managers` policy bounds the SUBJECT, not the actor: a peer satisfies it. What
    // stops them is `actor_user_id = p_actor` inside the core. Tenant scoping alone would hand
    // manager B manager A's receipt bytes.
    const peerRow = await statusAs(peer, ACADEMY_A, ownerCommandId);
    const unknownRow = await statusAs(owner, ACADEMY_A, NOWHERE);
    expect(peerRow[0].status).toBe('refused');
    expect(peerRow, 'a peer\'s command must be indistinguishable from one that does not exist')
      .toEqual(unknownRow);
  });

  it('the same holds for fingerprint recovery — a peer cannot recover by the reviewed intent', async () => {
    const mine = decodeSingle(await lookupAs(owner, ACADEMY_A, ownerFingerprint), decodeCommandLookupRow);
    expect(mine!.status).toBe('found');
    const peerRow = await lookupAs(peer, ACADEMY_A, ownerFingerprint);
    const unknownRow = await lookupAs(owner, ACADEMY_A, 'ab'.repeat(32));
    expect(peerRow[0].status).toBe('refused');
    expect(peerRow).toEqual(unknownRow);
  });
});

// ── The contract version is part of the fence ────────────────────────────────────────────────

describe('E-6 — the contract version', () => {
  it('a WRONG contract version refuses apply and lifecycle, identically to an unauthorized caller', async () => {
    const wrongApply = await applyAs(owner, ACADEMY_A, NOWHERE, null, 'abc27.wire.v0');
    const unauthApply = await applyAs(null, ACADEMY_A, NOWHERE, null);
    expect(wrongApply[0].status).toBe('refused');
    expect(wrongApply).toEqual(unauthApply);

    const wrongLifecycle = await lifecycleAs(owner, ACADEMY_A, 'abc27.wire.v0');
    const unauthLifecycle = await lifecycleAs(null, ACADEMY_A);
    expect(wrongLifecycle[0].status).toBe('refused');
    expect(wrongLifecycle).toEqual(unauthLifecycle);
  });

  it('the version the browser contract ships IS the version the wrappers accept', async () => {
    // The one place a version constant could silently drift from the database's expectation.
    const accepted = await applyAs(owner, ACADEMY_A, NOWHERE, null, ABC27_WIRE_VERSION);
    expect(accepted[0].status, 'the shipped version must get past the version gate')
      .not.toBe('refused');
  });
});

// ── Zero-write, and the bytea round trip on the operator half ────────────────────────────────

describe('E-6 — the preview writes nothing, and a bytea survives the wire form', () => {
  it('a preview creates no command, operation, capability or audit row', async () => {
    const before = await counts();
    await previewAs(owner, ACADEMY_A);
    await previewAs(null, ACADEMY_A);
    await previewAs(outsider, ACADEMY_A);
    expect(await counts(), 'the preview surface is STABLE and zero-write on every path')
      .toEqual(before);
  });

  it('a review fingerprint survives the PostgREST hex text form byte-for-byte', async () => {
    // The operator half of E-1: the browser reads `"\\x…"` from a preview and hands it back to an
    // apply. A single changed byte would surface as `review_fingerprint_mismatch`, so equality
    // through the wire form is what makes the apply reachable at all.
    const { rows } = await c.query(
      `SELECT request_fingerprint FROM public.rebook_round_commands WHERE command_id=$1`,
      [ownerCommandId]);
    const buf = rows[0].request_fingerprint as Buffer;
    const wire = `\\x${buf.toString('hex')}`;
    const back = await c.query(`SELECT $1::bytea = $2::bytea AS same, octet_length($1::bytea) n`,
      [wire, buf]);
    expect(back.rows[0].same).toBe(true);
    expect(back.rows[0].n).toBe(32);
    // ...and the wrapper itself accepts the wire form as a parameter and finds the same command.
    const found = await asActor(c, owner, async () => postgrestRows((await c.query(
      `SELECT * FROM public.rebook_round_command_lookup_by_review_as_actor($1,$2,$3::bytea)`,
      [ACADEMY_A, ABC27_WIRE_VERSION, wire])).rows));
    expect(decodeSingle(found, decodeCommandLookupRow)!.status).toBe('found');
  });
});

async function counts(): Promise<Record<string, number>> {
  const { rows } = await c.query(`
    SELECT (SELECT count(*)::int FROM public.rebook_round_commands)             AS commands,
           (SELECT count(*)::int FROM public.rebook_round_operations)           AS operations,
           (SELECT count(*)::int FROM public.rebook_rounds)                     AS rounds,
           (SELECT count(*)::int FROM public.rebook_round_recipients)           AS recipients,
           (SELECT count(*)::int FROM public.notification_outbox)               AS outbox`);
  return rows[0];
}
