// E-5 — the operator command driver, exercised through its injected RPC boundary.
//
// The four-hop protocol, every closed status, the failure modes that must read as `unknown` rather
// than as success or refusal, and the one property that decides whether a retry creates a second
// round: the command UUID is REUSED, not re-minted.
import { describe, expect, it } from 'vitest';
import {
  ABC27_WIRE_VERSION,
  APPLY_STATUSES,
  type ByteaHex,
  decodeApplyRow,
  decodePreviewRow,
  isByteaHex,
  PREVIEW_STATUSES,
  readReviewFingerprint,
  ROUND_COMMAND_STATUSES,
} from '@/lib/rebookRoundCommand';
import {
  applyRebookRoundCommand,
  previewRebookRoundCommand,
  recoverRebookRoundCommand,
  type RoundCommandIntent,
} from '@/lib/rebookRoundDriver';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const ROUND = '33333333-3333-4333-8333-333333333333';
const FINGERPRINT = ('\\x' + 'ab'.repeat(32)) as ByteaHex;

const intent = (over: Partial<RoundCommandIntent> = {}): RoundCommandIntent => ({
  academyProfileId: ACADEMY,
  commandKind: 'create',
  roundId: null,
  expectedVersion: null,
  label: 'Autumn block',
  targetStart: '2026-09-01',
  targetEnd: '2026-12-01',
  termWeeks: 12,
  priorityDays: 7,
  memberDays: 3,
  paymentMode: 'deferred_split',
  strictMollie: false,
  publicOpenMode: 'closed',
  publicOpenSplit: false,
  requireAdminReview: false,
  sessionPrice: null,
  autoReminder: true,
  reminderLeadHours: 24,
  invitationSubject: 's',
  invitationBody: 'b',
  reminderSubject: 'rs',
  reminderBody: 'rb',
  rebookRules: null,
  claimInfo: null,
  holidayFrom: [],
  holidayTo: [],
  holidayLabel: [],
  sourceSlotIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
  childCycleIds: ['cccccccc-cccc-4ccc-8ccc-ccccccccccc1'],
  ...over,
});

const previewRow = (over: Record<string, unknown> = {}) => ({
  status: 'previewed',
  contract_version: ABC27_WIRE_VERSION,
  review_fingerprint: FINGERPRINT,
  apply_eligibility: 'eligible',
  child_count: 1,
  source_count: 1,
  cohort_total: 4,
  occurrence_count: 12,
  claim_count: 48,
  holiday_row_count: 0,
  exclusion_range_count: 0,
  diagnostic_child: null,
  diagnostic_field: null,
  ...over,
});

/** The probe's answer: `invalid_request` because the identity pool was empty, plus the count. */
const probeRow = (occurrences = 12) => previewRow({
  status: 'invalid_request', review_fingerprint: null, apply_eligibility: null,
  occurrence_count: occurrences,
});

const applyRow = (over: Record<string, unknown> = {}) => ({
  status: 'applied',
  round_id: ROUND,
  command_id: '99999999-9999-4999-8999-999999999991',
  child_count: 1,
  occurrence_count: 12,
  claim_count: 48,
  receipt_canonical: '\\xdeadbeef',
  receipt_digest: '\\x' + '11'.repeat(32),
  detail: null,
  round_version: 1,
  ...over,
});

interface Harness {
  calls: { name: string; args: Record<string, unknown> }[];
  minted: string[];
}

function deps(script: (call: number, name: string, args: Record<string, unknown>) => unknown) {
  const h: Harness = { calls: [], minted: [] };
  let n = 0;
  let uuid = 0;
  return {
    h,
    deps: {
      rpc: (name: string, args: Record<string, unknown>) => {
        h.calls.push({ name, args });
        n += 1;
        const out = script(n, name, args);
        if (out instanceof Error) return Promise.reject(out);
        if (out && typeof out === 'object' && 'error' in (out as object)) {
          return Promise.resolve(out as { data: unknown; error: unknown });
        }
        return Promise.resolve({ data: out, error: null });
      },
      newUuid: () => {
        uuid += 1;
        const v = `dddddddd-dddd-4ddd-8ddd-${String(uuid).padStart(12, '0')}`;
        h.minted.push(v);
        return v;
      },
    },
  };
}

// ── The four hops ─────────────────────────────────────────────────────────────────────────────

describe('E-5 — probe, mint, preview', () => {
  it('probes with an EMPTY identity pool and mints EXACTLY the occurrence count the server named', async () => {
    const { deps: d, h } = deps((n) => (n === 1 ? [probeRow(12)] : [previewRow()]));
    const r = await previewRebookRoundCommand(intent(), d);
    expect(r.phase).toBe('reviewed');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].name).toBe('rebook_round_preview_command_as_actor');
    expect(h.calls[0].args.p_target_slot_ids, 'the probe submits no identities at all').toEqual([]);
    // 12 target identities + 1 command identity, and not one more.
    expect(h.minted).toHaveLength(13);
    expect(h.calls[1].args.p_target_slot_ids).toEqual(h.minted.slice(0, 12));
    if (r.phase !== 'reviewed') throw new Error('unreachable');
    expect(r.review.targetSlotIds).toHaveLength(12);
    expect(r.review.commandId).toBe(h.minted[12]);
    expect(r.review.reviewFingerprint).toBe(FINGERPRINT);
    expect(r.review.applyEligibility).toBe('eligible');
  });

  it('never derives the occurrence count itself — a different count mints a different pool', async () => {
    for (const n of [1, 5, 400]) {
      const { deps: d, h } = deps((call) => (call === 1 ? [probeRow(n)] : [previewRow({ occurrence_count: n })]));
      await previewRebookRoundCommand(intent(), d);
      expect((h.calls[1].args.p_target_slot_ids as string[]).length).toBe(n);
    }
  });

  it('sends the contract version on every hop, and NEVER an actor id', async () => {
    const { deps: d, h } = deps((n) => (n === 1 ? [probeRow()] : [previewRow()]));
    const r = await previewRebookRoundCommand(intent(), d);
    if (r.phase !== 'reviewed') throw new Error('unreachable');
    await applyRebookRoundCommand(r.review, {
      ...d,
      rpc: (name, args) => { h.calls.push({ name, args }); return Promise.resolve({ data: [applyRow()], error: null }); },
    });
    for (const c of h.calls) {
      expect(c.args.p_contract_version).toBe(ABC27_WIRE_VERSION);
      // THE WRAPPER DERIVES THE ACTOR FROM THE JWT. A parameter would be a caller-chosen identity,
      // and the `academy_managers` pair fence would then be checking a claim against itself.
      for (const key of Object.keys(c.args)) {
        expect(key, `${c.name} must not pass an actor identifier`).not.toMatch(/actor|user_id|auth/i);
      }
    }
  });

  it('a REFUSED probe is reported as-is: nothing is minted and nothing is previewed', async () => {
    const { deps: d, h } = deps(() => [probeRow(12)].map((r) => ({ ...r, status: 'round_not_found' })));
    const r = await previewRebookRoundCommand(intent(), d);
    expect(r.phase).toBe('refused');
    if (r.phase !== 'refused') throw new Error('unreachable');
    expect(r.status).toBe('round_not_found');
    expect(h.calls, 'the probe is not retried').toHaveLength(1);
    expect(h.minted, 'nothing is minted for a refused intent').toHaveLength(0);
  });

  it('a probe reporting ZERO occurrences is a refusal, not an empty round', async () => {
    const { deps: d, h } = deps(() => [probeRow(0)]);
    const r = await previewRebookRoundCommand(intent(), d);
    expect(r.phase).toBe('refused');
    expect(h.minted).toHaveLength(0);
  });

  it('a probe that answers `previewed` to an EMPTY pool is UNKNOWN, never a review', async () => {
    // The server would be saying it accepted a round with zero occurrences. Nothing downstream is
    // safe to build on that, so the driver refuses to understand it rather than proceeding.
    const { deps: d, h } = deps(() => [previewRow({ occurrence_count: 0 })]);
    const r = await previewRebookRoundCommand(intent(), d);
    expect(r.phase).toBe('unknown');
    if (r.phase !== 'unknown') throw new Error('unreachable');
    expect(r.reason).toBe('probe_not_understood');
    expect(h.minted).toHaveLength(0);
  });

  it('a refusal at the PREVIEW hop is reported, with the identities already minted discarded', async () => {
    const { deps: d } = deps((n) => (n === 1 ? [probeRow()] : [previewRow({
      status: 'incoherent_source', review_fingerprint: null, apply_eligibility: null,
      diagnostic_child: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', diagnostic_field: 'price',
    })]));
    const r = await previewRebookRoundCommand(intent(), d);
    expect(r.phase).toBe('refused');
    if (r.phase !== 'refused') throw new Error('unreachable');
    expect(r.status).toBe('incoherent_source');
    expect(r.preview?.diagnosticField, 'the identifier-only diagnostic is carried through').toBe('price');
  });

  it('EVERY closed preview status decodes, and nothing outside the vocabulary does', () => {
    for (const status of PREVIEW_STATUSES) {
      const row = status === 'previewed'
        ? previewRow()
        : previewRow({ status, review_fingerprint: null, apply_eligibility: null });
      expect(decodePreviewRow(row), `${status} must decode`).not.toBeNull();
    }
    for (const bogus of ['ok', 'created', 'success', 'PREVIEWED', '']) {
      expect(decodePreviewRow(previewRow({ status: bogus })), `${bogus} must not decode`).toBeNull();
    }
  });

  it('a `previewed` row without a well-formed 32-octet fingerprint is UNKNOWN', async () => {
    for (const bad of [null, '\\xab', 'not-hex', '\\x' + 'ab'.repeat(31)]) {
      const { deps: d } = deps((n) => (n === 1 ? [probeRow()] : [previewRow({ review_fingerprint: bad })]));
      const r = await previewRebookRoundCommand(intent(), d);
      expect(r.phase, `${String(bad)} must not become a review`).toBe('unknown');
    }
  });
});

// ── Apply, and the retry identity ─────────────────────────────────────────────────────────────

describe('E-5 — apply', () => {
  const reviewed = async () => {
    const { deps: d, h } = deps((n) => (n === 1 ? [probeRow()] : [previewRow()]));
    const r = await previewRebookRoundCommand(intent(), d);
    if (r.phase !== 'reviewed') throw new Error('expected a review');
    return { review: r.review, h };
  };

  it('applies the REVIEWED arguments verbatim, plus the command id and the fingerprint', async () => {
    const { review } = await reviewed();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const r = await applyRebookRoundCommand(review, {
      rpc: (name, args) => { calls.push({ name, args }); return Promise.resolve({ data: [applyRow()], error: null }); },
      newUuid: () => { throw new Error('apply must not mint anything'); },
    });
    expect(r.phase).toBe('applied');
    expect(calls[0].name).toBe('rebook_round_apply_command_as_actor');
    expect(calls[0].args.p_command_id).toBe(review.commandId);
    expect(calls[0].args.p_review_fingerprint).toBe(review.reviewFingerprint);
    expect(calls[0].args.p_target_slot_ids, 'the reviewed identities, unchanged')
      .toBe(review.targetSlotIds);
  });

  it('A RETRY REUSES THE SAME command_id — asserted by identity, not by "a retry happened"', async () => {
    const { review } = await reviewed();
    const seen: unknown[] = [];
    const rpc = (name: string, args: Record<string, unknown>) => {
      seen.push(args.p_command_id);
      // First attempt: the transport dies. Second: the server replays the stored receipt.
      return seen.length === 1
        ? Promise.reject(new Error('network'))
        : Promise.resolve({ data: [applyRow({ status: 'replayed' })], error: null });
    };
    const first = await applyRebookRoundCommand(review, { rpc, newUuid: () => 'must-not-be-called' });
    expect(first.phase).toBe('unknown');
    if (first.phase !== 'unknown') throw new Error('unreachable');
    expect(first.commandId, 'an unknown carries the ONLY thing that can resolve it').toBe(review.commandId);

    const second = await applyRebookRoundCommand(review, { rpc, newUuid: () => 'must-not-be-called' });
    expect(second.phase).toBe('applied');
    if (second.phase !== 'applied') throw new Error('unreachable');
    expect(second.status, 'a replay is the stored receipt of the same command').toBe('replayed');
    // THE PROPERTY: both attempts presented the IDENTICAL command identity.
    expect(seen).toEqual([review.commandId, review.commandId]);
    expect(new Set(seen).size).toBe(1);
  });

  it('`replayed` is a SUCCESS — treating it as a failure is how a retry becomes a second round', async () => {
    const { review } = await reviewed();
    const r = await applyRebookRoundCommand(review, {
      rpc: () => Promise.resolve({ data: [applyRow({ status: 'replayed' })], error: null }),
      newUuid: () => 'x',
    });
    expect(r.phase).toBe('applied');
  });

  it('a half-populated success row is UNKNOWN, never "created"', async () => {
    const { review } = await reviewed();
    for (const missing of [{ round_id: null }, { receipt_canonical: null }, { receipt_digest: null }]) {
      const r = await applyRebookRoundCommand(review, {
        rpc: () => Promise.resolve({ data: [applyRow(missing)], error: null }),
        newUuid: () => 'x',
      });
      expect(r.phase, `${JSON.stringify(missing)} must not read as applied`).toBe('unknown');
      if (r.phase !== 'unknown') throw new Error('unreachable');
      expect(r.reason).toBe('unreadable_apply');
    }
  });

  it('EVERY closed apply status decodes and is classified as success or refusal, never both', () => {
    for (const status of APPLY_STATUSES) {
      const row = decodeApplyRow(applyRow({ status, ...(status === 'applied' || status === 'replayed'
        ? {} : { round_id: null, receipt_canonical: null, receipt_digest: null }) }));
      expect(row, `${status} must decode`).not.toBeNull();
    }
    // `previewed` is a PREVIEW answer and must not decode as an apply outcome.
    expect(decodeApplyRow(applyRow({ status: 'previewed' }))).toBeNull();
  });

  it('a PostgREST error object is UNKNOWN, and still carries the command id', async () => {
    const { review } = await reviewed();
    const r = await applyRebookRoundCommand(review, {
      rpc: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
      newUuid: () => 'x',
    });
    expect(r.phase).toBe('unknown');
    if (r.phase !== 'unknown') throw new Error('unreachable');
    expect(r.commandId).toBe(review.commandId);
  });

  it('zero rows and two rows are both drift — a closed envelope always returns exactly one', async () => {
    const { review } = await reviewed();
    for (const data of [[], [applyRow(), applyRow()], null, 'row']) {
      const r = await applyRebookRoundCommand(review, {
        rpc: () => Promise.resolve({ data, error: null }), newUuid: () => 'x',
      });
      expect(r.phase).toBe('unknown');
    }
  });
});

// ── Recovery ──────────────────────────────────────────────────────────────────────────────────

describe('E-5 — recovery after an unknown', () => {
  const review = {
    intent: intent(),
    commandId: '99999999-9999-4999-8999-999999999991',
    reviewFingerprint: FINGERPRINT,
  };
  const statusRow = (over: Record<string, unknown> = {}) => ({
    status: 'found', command_kind: 'create', round_id: ROUND,
    receipt_canonical: '\\xdeadbeef', receipt_digest: '\\x' + '11'.repeat(32),
    applied_at: '2026-08-25T10:00:00Z', ...over,
  });
  const lookupRow = (over: Record<string, unknown> = {}) => ({
    ...statusRow(), command_id: review.commandId, ...over,
  });

  it('asks by command UUID first, and stops there when it finds the receipt', async () => {
    const calls: string[] = [];
    const r = await recoverRebookRoundCommand(review, {
      rpc: (name) => { calls.push(name); return Promise.resolve({ data: [statusRow()], error: null }); },
    });
    expect(r.phase).toBe('found');
    expect(calls).toEqual(['rebook_round_command_status_as_actor']);
  });

  it('falls back to the REVIEWED FINGERPRINT when the UUID finds nothing', async () => {
    const calls: string[] = [];
    const r = await recoverRebookRoundCommand(review, {
      rpc: (name) => {
        calls.push(name);
        return Promise.resolve({
          data: [name.endsWith('status_as_actor')
            ? statusRow({ status: 'refused', command_kind: null, round_id: null,
              receipt_canonical: null, receipt_digest: null, applied_at: null })
            : lookupRow()],
          error: null,
        });
      },
    });
    expect(calls).toEqual([
      'rebook_round_command_status_as_actor',
      'rebook_round_command_lookup_by_review_as_actor',
    ]);
    expect(r.phase).toBe('found');
  });

  it('reports not_found when NEITHER surface knows the command', async () => {
    const refused = statusRow({ status: 'refused', command_kind: null, round_id: null,
      receipt_canonical: null, receipt_digest: null, applied_at: null });
    const r = await recoverRebookRoundCommand(review, {
      rpc: (name) => Promise.resolve({
        data: [name.endsWith('by_review_as_actor') ? { ...refused, command_id: null } : refused],
        error: null,
      }),
    });
    // `refused` here is deliberately the SAME row a foreign academy produces, so a caller cannot
    // use this surface to probe for anyone else's commands.
    expect(r.phase).toBe('not_found');
  });

  it('an unreadable recovery row is UNKNOWN — never "the command did not apply"', async () => {
    const r = await recoverRebookRoundCommand(review, {
      rpc: () => Promise.resolve({ data: [{ status: 'found' }], error: null }),
    });
    expect(r.phase).toBe('unknown');
  });

  it('recovery NEVER re-applies: it names only the two read surfaces', async () => {
    const calls: string[] = [];
    await recoverRebookRoundCommand(review, {
      rpc: (name) => {
        calls.push(name);
        const refused = statusRow({ status: 'refused', command_kind: null, round_id: null,
          receipt_canonical: null, receipt_digest: null, applied_at: null });
        return Promise.resolve({
          data: [name.endsWith('by_review_as_actor') ? { ...refused, command_id: null } : refused],
          error: null,
        });
      },
    });
    expect(calls.every((n) => n.includes('status_as_actor') || n.includes('lookup_by_review_as_actor'))).toBe(true);
    expect(calls.some((n) => n.includes('apply'))).toBe(false);
  });
});

// ── The wire contract itself ──────────────────────────────────────────────────────────────────

describe('E-5 — the wire contract', () => {
  it('pins the exact contract version the wrappers demand', () => {
    expect(ABC27_WIRE_VERSION).toBe('abc27.wire.v1');
  });

  it('mirrors the database vocabulary exactly, with no extras', () => {
    expect(ROUND_COMMAND_STATUSES).toHaveLength(19);
    expect(new Set(ROUND_COMMAND_STATUSES).size).toBe(ROUND_COMMAND_STATUSES.length);
    // `refused` is the WRAPPER's answer and must NOT be in the core's vocabulary: conflating them
    // would make an authorization refusal indistinguishable from a validation refusal.
    expect(ROUND_COMMAND_STATUSES as readonly string[]).not.toContain('refused');
    expect(PREVIEW_STATUSES as readonly string[]).toContain('refused');
    expect(APPLY_STATUSES as readonly string[]).toContain('refused');
    expect(PREVIEW_STATUSES as readonly string[]).toContain('previewed');
    expect(APPLY_STATUSES as readonly string[]).not.toContain('previewed');
  });

  it('recognises the PostgREST bytea wire form, and only that', () => {
    expect(isByteaHex('\\xdeadbeef')).toBe(true);
    expect(isByteaHex('\\x')).toBe(true);
    for (const bad of ['deadbeef', '\\xdeadbee', '\\xzz', '0xdeadbeef', '', null, 42, new Uint8Array()]) {
      expect(isByteaHex(bad), `${String(bad)} is not the wire form`).toBe(false);
    }
  });

  it('accepts a fingerprint of EXACTLY 32 octets and nothing else', () => {
    expect(readReviewFingerprint('\\x' + 'ab'.repeat(32))).not.toBeNull();
    expect(readReviewFingerprint('\\x' + 'ab'.repeat(31))).toBeNull();
    expect(readReviewFingerprint('\\x' + 'ab'.repeat(33))).toBeNull();
    expect(readReviewFingerprint(null)).toBeNull();
  });
});
