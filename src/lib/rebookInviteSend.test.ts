import { describe, it, expect, vi } from 'vitest';
import { createAndDrainRebookRound, drainRebookInvites, drainRebookRoundInvites, previewRebookRound, readChunkResponse, type DrainResult, type SendChunkResult } from './rebookInviteSend';

/** Fill the SendChunkResult defaults so a scripted chunk can specify only the fields it exercises. */
const chunk = (c: Partial<SendChunkResult>): SendChunkResult => ({
  sent: 0, failed: 0, already: 0, suppressed: 0, held: 0, unstamped: 0, attempted: 0, remaining: 0,
  failedClaimIds: [], unresolvedClaimIds: [], sampleError: null, ...c,
});

/** A fake sender that replays a scripted list of chunk results. */
const scripted = (chunks: Array<Partial<SendChunkResult>>) => {
  let i = 0;
  return vi.fn(async () => chunk(chunks[Math.min(i++, chunks.length - 1)]));
};

describe('drainRebookInvites', () => {
  it('loops until remaining hits 0 and sums the sent count', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 60, failedClaimIds: [], attempted: 40 },
      { sent: 40, failed: 0, remaining: 20, failedClaimIds: [], attempted: 40 },
      { sent: 20, failed: 0, remaining: 0, failedClaimIds: [], attempted: 20 },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(100);
    expect(r.leftover).toBe(0);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it('the denominator counts the unresolved attempts it will report as outstanding (round 5)', async () => {
    // A first chunk of 10 that yields 4 sent, 2 unresolved and 4 remaining is a SENDABLE SET OF TEN.
    // The old denominator was `sent + failed + remaining` = 8, while `stillToSend` counted the two
    // unresolved — so the very first progress event rendered "4 sent, 6 to go, of 8". A progress bar
    // whose parts exceed its whole is not a rounding nit: it is the surface telling the manager the
    // batch is smaller than the work it is about to report.
    const sender = scripted([
      { sent: 4, failed: 0, held: 2, remaining: 4, unresolvedClaimIds: ['u1', 'u2'], attempted: 6 },
      { sent: 4, failed: 0, held: 0, unstamped: 0, remaining: 0, attempted: 4 },
    ]);
    const seen: Array<{ sent: number; stillToSend: number; total: number }> = [];
    const r = await drainRebookInvites('cyc', {
      sender,
      onProgress: (p) => seen.push({ sent: p.totalSent, stillToSend: p.stillToSend, total: p.total }),
    });
    expect(seen[0].total, 'the sendable total includes the unresolved attempts').toBe(10);
    for (const p of seen) {
      expect(p.sent + p.stillToSend, 'the parts never exceed the whole').toBeLessThanOrEqual(p.total);
    }
    expect(r.totalSent).toBe(8);
    expect(r.stoppedReason).toBe('drained');
  });

  it('the denominator is attempted + remaining, with nothing to subtract (convergence)', async () => {
    // The buckets are DISJOINT now, so the sendable set is simply what a chunk attempted plus what
    // is left. Every earlier version of this arithmetic adjusted for an overlap between `sent` and
    // `unresolved`, and three review rounds in a row found a consumer that adjusted it wrongly.
    // 10 sendable: 4 attempted (all queued but un-stamped), 6 still to come.
    const sender = scripted([
      { sent: 0, unstamped: 4, attempted: 4, remaining: 6, unresolvedClaimIds: ['a', 'b', 'c', 'd'] },
    ]);
    const seen: Array<{ total: number; sent: number; stillToSend: number }> = [];
    const r = await drainRebookInvites('cyc', {
      sender,
      onProgress: (p) => seen.push({ total: p.total, sent: p.totalSent, stillToSend: p.stillToSend }),
    });
    expect(seen[0].total, 'ten sendable claims, counted once each').toBe(10);
    for (const p of seen) {
      expect(p.sent + p.stillToSend, 'the parts never exceed the whole').toBeLessThanOrEqual(p.total);
    }
    // The four un-stamped ones are still outstanding, and so are the six untouched — ten, with
    // nothing double-counted and nothing subtracted away.
    expect(r.leftover, 'an un-stamped claim is leftover work, not a completed one').toBe(10);
    expect(r.stoppedReason, 'and a chunk that queued nothing is a stall').toBe('no_progress');
  });

  it('reports progress as it drains', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [], attempted: 40 },
      { sent: 40, failed: 0, remaining: 0, failedClaimIds: [], attempted: 40 },
    ]);
    const progress: number[] = [];
    await drainRebookInvites('cyc', { sender, onProgress: (p) => progress.push(p.totalSent) });
    expect(progress).toEqual([40, 80]);
  });

  it('pins a stable sendable total from the first chunk (excludes emailless)', async () => {
    // First chunk: 40 sent + 0 failed + 40 remaining ⇒ sendable total = 80, even
    // though the round may have more (emailless) representatives.
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [], attempted: 40 },
      { sent: 40, failed: 0, remaining: 0, failedClaimIds: [], attempted: 40 },
    ]);
    const totals: number[] = [];
    await drainRebookInvites('cyc', { sender, onProgress: (p) => totals.push(p.total) });
    expect(totals).toEqual([80, 80]);
  });

  it('stops on no-progress (a whole chunk failed) and reports the leftover', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [], attempted: 40 },
      // Everything in this chunk failed (rolled back) — no forward progress.
      { sent: 0, failed: 40, remaining: 0, failedClaimIds: ['a', 'b'], attempted: 40 },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('no_progress');
    expect(r.totalSent).toBe(40);
    // Untouched (0) + this chunk's rolled-back failures (40) still to send.
    expect(r.leftover).toBe(40);
    expect(r.failedClaimIds.sort()).toEqual(['a', 'b']);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('a chunk of all-UNRESOLVED sends is NOT drained (Codex round-7 #1)', async () => {
    // Every email went out but every invited_at stamp failed: sent=40, unresolved=40, remaining=0.
    // The claims are still un-stamped and need a retry — this must NOT report `drained`.
    const sender = scripted([
      { sent: 40, failed: 0, held: 40, remaining: 0, unresolvedClaimIds: ['u1', 'u2'], attempted: 80 },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('unresolved');
    expect(r.leftover).toBe(40); // the 40 un-stamped sends still need resolving
    expect(r.unresolvedClaimIds.sort()).toEqual(['u1', 'u2']);
    expect(sender).toHaveBeenCalledTimes(1); // stops immediately (retryable), never loops re-sending
  });

  it('drains cleanly once a follow-up chunk resolves the earlier remaining work', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, held: 0, unstamped: 0, remaining: 10, attempted: 40 },
      { sent: 10, failed: 0, held: 0, unstamped: 0, remaining: 0, attempted: 10 },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(50);
    expect(r.leftover).toBe(0);
  });

  it('treats an immediate "nothing to send" as drained (already all invited)', async () => {
    const sender = scripted([{ sent: 0, failed: 0, remaining: 0, failedClaimIds: [], attempted: 0 }]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(0);
    expect(r.leftover).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('a FIRST-chunk throw reports leftover = null (UNKNOWN), never a fabricated 0 (Codex round-10 #1)', async () => {
    const sender = vi.fn(async () => { throw new Error('network'); });
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.totalSent).toBe(0);
    expect(r.leftover).toBe(null); // an error before any count was learned ⇒ unknown, NOT zero
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('a throw AFTER a chunk still reports leftover null — the prior count is only a stale upper bound (Codex round-11 #1)', async () => {
    let call = 0;
    const sender = vi.fn(async () => {
      if (call++ === 0) return chunk({ sent: 40, remaining: 50, attempted: 40 });
      throw new Error('network'); // may have landed AFTER the edge sent — the remainder is now UNKNOWN
    });
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.totalSent).toBe(40);
    expect(r.leftover).toBe(null); // authoritative remainder is unknown on ANY error
    expect(r.lastKnownLeftover).toBe(50); // the prior observation is exposed separately, non-authoritative
  });

  it('hitting maxIterations reports iteration_limit + real leftover, NOT drained (Codex round-8 #1)', async () => {
    // A large run that always sends a little but never fully drains — the 500-iteration backstop must
    // NOT masquerade as a clean drain with leftover 0.
    const sender = vi.fn(async () => chunk({ sent: 1, failed: 0, remaining: 999, attempted: 1 }));
    const r = await drainRebookInvites('cyc', { sender, maxIterations: 5 });
    expect(sender).toHaveBeenCalledTimes(5);
    expect(r.totalSent).toBe(5);
    expect(r.stoppedReason).toBe('iteration_limit');
    expect(r.leftover).toBe(999); // outstanding work is surfaced, not hidden
  });

  it('a chunk that sends NOTHING while work remains is no_progress, NOT drained (Codex round-8 #1)', async () => {
    // sent:0 with remaining>0 (e.g. nothing eligible resolved this pass) — must not report drained.
    const sender = vi.fn(async () => chunk({ sent: 0, failed: 0, remaining: 50, attempted: 0 }));
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('no_progress');
    expect(r.leftover).toBe(50);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('forwards the chunk limit and custom copy to the sender', async () => {
    const sender = vi.fn(async () => chunk({ sent: 0, failed: 0, remaining: 0, attempted: 0 }));
    await drainRebookInvites('cyc', { sender, limit: 25, customMessage: 'hi', customSubject: 'subj' });
    expect(sender).toHaveBeenCalledWith({ cycleId: 'cyc', limit: 25, customMessage: 'hi', customSubject: 'subj' });
  });
});

/** A sender that scripts chunk results PER cycleId (for round-level drain across sibling cycles). */
const scriptedByCycle = (byCycle: Record<string, Array<Partial<SendChunkResult>>>) => {
  const idx: Record<string, number> = {};
  return vi.fn(async ({ cycleId }: { cycleId: string }) => {
    const chunks = byCycle[cycleId] ?? [{}];
    const i = idx[cycleId] ?? 0;
    idx[cycleId] = i + 1;
    return chunk(chunks[Math.min(i, chunks.length - 1)]);
  });
};

describe('drainRebookRoundInvites', () => {
  it('carries the ROUND to every cycle chunk — a protected invitation cannot be enqueued without it', async () => {
    // The edge refuses a live send with no `roundId`, and the database refuses the enqueue after it.
    // Neither refusal is reachable from here, so what this asserts is the only thing that can break
    // silently: that the round the caller knows actually travels to the sender for EVERY cycle.
    const sender = scriptedByCycle({
      a: [{ sent: 1, failed: 0, remaining: 0, failedClaimIds: [], attempted: 1 }],
      b: [{ sent: 1, failed: 0, remaining: 0, failedClaimIds: [], attempted: 1 }],
    });
    await drainRebookRoundInvites(['a', 'b'], { sender, roundId: 'round-7' });
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ cycleId: 'a', roundId: 'round-7' }));
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ cycleId: 'b', roundId: 'round-7' }));
    expect(sender).toHaveBeenCalledTimes(2);
  });


  it('drains every sibling cycle and merges the counts into one round result', async () => {
    const sender = scriptedByCycle({
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [], attempted: 2 }],
      b: [{ sent: 3, failed: 0, remaining: 0, failedClaimIds: [], attempted: 3 }],
    });
    const r = await drainRebookRoundInvites(['a', 'b'], { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(5);
    expect(r.leftover).toBe(0);
    // Each cycle drained independently (its send-priority-claim-invitation is scoped by cyclus_id).
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ cycleId: 'a' }));
    expect(sender).toHaveBeenCalledWith(expect.objectContaining({ cycleId: 'b' }));
  });

  it('propagates a partial/leftover from any one sibling into the round result', async () => {
    const sender = scriptedByCycle({
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [], attempted: 2 }],
      b: [{ sent: 0, failed: 2, remaining: 0, failedClaimIds: ['x', 'y'], attempted: 2 }], // whole chunk failed → no_progress
    });
    const r = await drainRebookRoundInvites(['a', 'b'], { sender });
    expect(r.totalSent).toBe(2);
    expect(r.leftover).toBe(2);
    expect(r.stoppedReason).toBe('no_progress');
    expect(r.failedClaimIds.sort()).toEqual(['x', 'y']);
  });

  it('round progress is round-wide: total never decreases and is always >= sent (Codex round-11 #2)', async () => {
    // Cycle a has 2 recipients, cycle b has 3. Progress must never render an impossible "5 / 3" — the
    // denominator is round-wide (2 + 3) like the numerator, and both are monotonic non-decreasing.
    const sender = scriptedByCycle({
      a: [{ sent: 2, remaining: 0, attempted: 2 }],
      b: [{ sent: 3, remaining: 0, attempted: 3 }],
    });
    const seen: Array<{ sent: number; total: number }> = [];
    await drainRebookRoundInvites(['a', 'b'], { sender, onProgress: (p) => seen.push({ sent: p.totalSent, total: p.total }) });
    expect(seen.length).toBeGreaterThan(0);
    let prevTotal = 0, prevSent = 0;
    for (const p of seen) {
      expect(p.total, `total ${p.total} must not drop below the previous ${prevTotal}`).toBeGreaterThanOrEqual(prevTotal);
      expect(p.total, `total ${p.total} must be >= sent ${p.sent}`).toBeGreaterThanOrEqual(p.sent);
      expect(p.sent).toBeGreaterThanOrEqual(prevSent);
      prevTotal = p.total;
      prevSent = p.sent;
    }
    expect(seen[seen.length - 1]).toEqual({ sent: 5, total: 5 }); // final progress is the whole round
  });

  it('a sibling cycle whose first chunk THROWS makes the round leftover null/unknown (Codex round-10 #1)', async () => {
    // Cycle a drains cleanly; cycle b's first send throws before any count is learned. The round total
    // outstanding is then genuinely unknown — it must NOT be summed to a fabricated number.
    const sender = vi.fn(async ({ cycleId }: { cycleId: string }) => {
      if (cycleId === 'a') return chunk({ sent: 5, remaining: 0, attempted: 5 });
      throw new Error('cycle b down');
    });
    const r = await drainRebookRoundInvites(['a', 'b'], { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.leftover).toBe(null); // once any cycle's count is unknown, the round leftover is unknown
    expect(r.totalSent).toBe(5);
  });

  it('reports round-level progress rebased across cycles', async () => {
    const sender = scriptedByCycle({
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [], attempted: 2 }],
      b: [{ sent: 3, failed: 0, remaining: 0, failedClaimIds: [], attempted: 3 }],
    });
    const seen: number[] = [];
    await drainRebookRoundInvites(['a', 'b'], { sender, onProgress: (p) => seen.push(p.totalSent) });
    // Running totals never go backwards across the cycle boundary.
    expect(seen).toEqual([2, 5]);
  });

  it('a single-cycle round behaves exactly like the per-cycle drain', async () => {
    const sender = scriptedByCycle({ solo: [{ sent: 4, failed: 0, remaining: 0, failedClaimIds: [], attempted: 4 }] });
    const r = await drainRebookRoundInvites(['solo'], { sender });
    expect(r.totalSent).toBe(4);
    expect(r.stoppedReason).toBe('drained');
  });
});

const drainResult = (over: Partial<DrainResult>): DrainResult => ({
  totalSent: 0, leftover: 0, lastKnownLeftover: 0, stoppedReason: 'drained', failedClaimIds: [], unresolvedClaimIds: [], sampleError: null, ...over,
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// createAndDrainRebookRound / previewRebookRound — the TRUTH BOUNDARY, on the TYPED path.
//
// The edge producer is gone. `bulk-rebook-cycle` decided which slots a selection meant, clustered
// them, named the children and created the round; the database does all of that now, and these two
// functions are the browser's only way to ask. The truth boundary is unchanged and is what this
// suite is organised around — there are four things that can be true after asking to create a
// round, and exactly one of them may drain, navigate or celebrate:
//
//   created           every field the caller will act on was decoded and validated.
//   creation_failed   the server PROVED no round exists, in its own typed vocabulary.
//   selection_moved   the selection is not what the operator reviewed. Nothing was written.
//   unknown           anything else. Zero invites drained, no success, no navigation.
//
// WHAT CHANGED, AND WHAT DELIBERATELY DID NOT. The legacy shapes these tests used to police —
// `phase: 'delivery'`, `invitesDeferred`, a 409 `FunctionsHttpError` carrying a preflight refusal,
// a reconstructed inline-send accounting — cannot occur any more, because nothing posts to an edge
// function. The RULES they enforced are all still here, asserted against the shapes that can:
// an incomplete answer is never read as proof of absence, a transport failure never claims the
// round does not exist, and no accounting is ever reconstructed from numbers we did not observe.
// ════════════════════════════════════════════════════════════════════════════════════════════

const CY1 = '11111111-1111-4111-8111-111111111111';
const CY2 = '22222222-2222-4222-8222-222222222222';
const ROUND = '33333333-3333-4333-8333-333333333333';
const SESSION = { roundId: ROUND, selectionDigest: null };
/**
 * What a review produced, as the send must present it back.
 *
 * THE FINGERPRINT BINDS THESE. Sections 6 and 7 of the canonical pre-image canonicalize the minted
 * `target_slot_id` per occurrence and per claim tuple, so a send that re-minted would be sending an
 * intent nobody reviewed — and the server would report that as source drift.
 */
const REVIEWED = {
  selectionDigest: '\\xd19657',
  reviewFingerprint: '\\x0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de',
  targetSlotIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
  commandId: '44444444-4444-4444-8444-444444444444',
  // The DISTINCT cohort the operator approved — five people, not the forty claims the apply
  // returns for them across eight sessions.
  cohortTotal: 5,
  // A CREATE carries no version. Only an extend is fenced on one.
  expectedVersion: null,
};

/** One `result` row of the selection surface, with only the fields a case exercises. */
const resultRow = (over: Record<string, unknown> = {}) => ({
  row_kind: 'result',
  status: 'previewed',
  contract_version: 'abc27.wire.v1',
  review_fingerprint: '\\x0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de',
  selection_digest: '\\xd19657',
  apply_eligibility: 'eligible',
  child_count: 1,   // ONE series row ships with this fixture; the decoder now checks
  source_count: 6,
  cohort_total: 5,   // FIVE distinct people, and the series below now really carries five
  occurrence_count: 8,
  claim_count: 40,
  total_sessions: 40,
  no_email_total: 1,
  grand_invoice_total: '200.00',
  already_sent_groups: 0,
  source_term_weeks: 8,
  source_modal_price: '25.00',
  source_prices_include_vat: true,
  ...over,
});

const seriesRow = (over: Record<string, unknown> = {}) => ({
  row_kind: 'series',
  series_key: 'k1',
  child_cycle_id: CY1,
  series_excluded: false,
  target_name: 'Volgende ronde 2026 — Wo 09:00',
  local_weekday: 3,
  local_time: '09:00:00',
  trainer_id: null,
  trainer_name: 'Sanne',
  location_id: null,
  location_name: null,
  max_participants: 4,
  source_price: '25.00',
  split_payment: false,
  prices_include_vat: true,
  // FIVE subjects, and five roster rows ship beside them.
  //
  // REVIEW ROUND 5 (P2): this said ONE while the result row said five distinct people, and the
  // decoder accepted it — so every review test was normalising a response the surface cannot
  // produce. `cohort_total` counts a person once across the included series, which cannot exceed
  // their summed subjects; one subject and five people is not a shape that exists.
  subject_count: 5,
  sessions: 8,
  invoice_total: '200.00',
  no_email_count: 1,
  ...over,
});

/** The apply surface's single row. */
const applyRow = (over: Record<string, unknown> = {}) => ({
  status: 'applied',
  round_id: ROUND,
  command_id: '44444444-4444-4444-8444-444444444444',
  child_count: 2,
  occurrence_count: 8,
  claim_count: 40,
  child_cycle_ids: [CY1, CY2],
  ...over,
});

/**
 * A scripted RPC. `probe` answers the empty-pool call, `review` the minted one, `apply` the write.
 *
 * THE PROBE AND THE REVIEW ARE THE SAME FUNCTION, told apart by whether the caller minted target
 * identities yet — which is exactly how the server tells them apart, so a fake that ignored the
 * difference would let a driver bug through.
 */
function scriptedRpc(script: {
  probe?: unknown; review?: unknown; apply?: unknown; error?: unknown; recover?: unknown;
} = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (script.error) return { data: null, error: script.error };
    // `in`, NOT `??`: a case that scripts `null` is scripting a NULL ANSWER, and `??` would
    // silently hand it the default instead — a fake that cannot express the thing under test.
    if (fn === 'rebook_round_selection_apply_as_actor') {
      return { data: 'apply' in script ? script.apply : [applyRow()], error: null };
    }
    // THE COMMAND LEDGER. Both recovery surfaces answer a closed envelope, and `refused` — "no
    // such command FOR THIS ACTOR" — is the default, because in almost every case here nothing
    // was ever committed. A case that scripts `recover` is scripting a round that DID commit.
    if (fn === 'rebook_round_command_status_as_actor'
        || fn === 'rebook_round_command_lookup_by_review_as_actor') {
      // THE TWO SURFACES RETURN DIFFERENT SHAPES, and the decoder demands EXACTLY the right keys.
      // The status surface was asked for a command id and does not echo it (six columns); the
      // lookup surface returns the one it found (seven). A fixture that shipped one shape for both
      // was describing an answer neither surface sends — and the strict decoder said so.
      const byReview = fn === 'rebook_round_command_lookup_by_review_as_actor';
      const rows = ('recover' in script ? script.recover : [refusedLedgerRow()]) as Array<Record<string, unknown>>;
      return {
        data: rows.map((r) => (byReview
          ? { ...r, command_id: r.command_id ?? null }
          : Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'command_id')))),
        error: null,
      };
    }
    const minted = (args.p_target_slot_ids as unknown[] | null) ?? [];
    if (minted.length === 0) {
      return {
        // THE PROBE CARRIES ITS SERIES AND ROSTER ROWS TOO, because the real surface does. Only a
        // WRAPPER refusal returns a lone result row (`..._actor_surface.sql:363-377`); the probe's
        // `invalid_request` is the CORE's verdict on an empty pool, reached long after the series
        // and roster queries have run under `p_projection = 'review'` (`:596`). A fixture that
        // shipped a result row alone was describing an answer the server never sends.
        data: 'probe' in script
          ? script.probe
          : [resultRow({ status: 'invalid_request', review_fingerprint: null }), seriesRow(),
             ...rosterRowsFor('k1', 5, 1)],
        error: null,
      };
    }
    return {
      data: 'review' in script ? script.review
        : [resultRow(), seriesRow(), ...rosterRowsFor('k1', 5, 1)],
      error: null,
    };
  });
  return { rpc, calls };
}

let uuidSeq = 0;
const newUuid = () => `00000000-0000-4000-8000-${String((uuidSeq += 1)).padStart(12, '0')}`;

describe('createAndDrainRebookRound — verified creation', () => {
  it('the REVIEW probes, mints exactly `occurrence_count` identities and reviews — in that order', async () => {
    const { rpc, calls } = scriptedRpc();
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');

    expect(calls.map((c) => c.fn))
      .toEqual(['rebook_round_selection_preview_as_actor', 'rebook_round_selection_preview_as_actor']);
    expect(calls[0].args.p_target_slot_ids, 'the probe carries an EMPTY pool').toEqual([]);
    expect(calls[1].args.p_target_slot_ids, 'and the review carries exactly what the probe asked for')
      .toHaveLength(8);
    expect(calls[1].args.p_selection_digest, 'the probe\'s digest is echoed into the review')
      .toBe('\\xd19657');
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect(r.reviewed?.targetSlotIds, 'the minted identities are carried out for the send')
      .toEqual(calls[1].args.p_target_slot_ids);
    expect(r.reviewed?.reviewFingerprint).toBe('\\x0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de');
  });

  it('the SEND applies exactly what was reviewed, and re-derives nothing', async () => {
    const { rpc, calls } = scriptedRpc();
    await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn(async () => drainResult({ totalSent: 40 })) }, SESSION, REVIEWED);
    expect(calls.map((c) => c.fn), 'ONE call: no re-review, no re-probe')
      .toEqual(['rebook_round_selection_apply_as_actor']);
    expect(calls[0].args.p_target_slot_ids, 'the reviewed identities, unchanged')
      .toEqual(REVIEWED.targetSlotIds);
    expect(calls[0].args.p_review_fingerprint).toBe(REVIEWED.reviewFingerprint);
    expect(calls[0].args.p_command_id, 'and the command uuid the review minted')
      .toBe(REVIEWED.commandId);
    expect(calls[0].args.p_projection, 'the apply describes nothing').toBeUndefined();
  });

  it('THE BROWSER NEVER SENDS A SOURCE SLOT ARRAY — on any call, review or send', async () => {
    const { rpc, calls } = scriptedRpc();
    const body = { academyProfileId: CY1, sourceCyclusId: CY2 };
    await previewRebookRound(body, { rpc, newUuid }, SESSION, 'review');
    await createAndDrainRebookRound(body, { rpc, drain: vi.fn(async () => drainResult({})) },
      SESSION, REVIEWED);
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) {
      expect(Object.keys(call.args), `${call.fn} must not carry source slots`)
        .not.toContain('p_source_slot_ids');
      expect(Object.keys(call.args)).not.toContain('p_child_cycle_ids');
    }
  });

  it('drains EVERY child cycle the server reported, and never one it did not', async () => {
    const { rpc } = scriptedRpc();
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain }, SESSION, REVIEWED);
    expect(drain).toHaveBeenCalledWith([CY1, CY2], expect.anything());
  });

  it('clean drain → created, leftover 0, and every field is the DECODED one', async () => {
    const { rpc } = scriptedRpc();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn(async () => drainResult({ totalSent: 40 })) }, SESSION, REVIEWED);
    // ROUND 2 (P2): `players` is the REVIEW's distinct cohort, not the apply's `claim_count`.
    // Forty claims is five people across eight sessions; reporting forty told the operator they
    // had invited forty.
    expect(r).toEqual({
      phase: 'created', targetCycleId: CY1, roundId: ROUND, groups: 2, players: 5,
      totalSent: 40, leftover: 0, outcome: 'drained', sampleError: null,
      // OD1/OD2: what the SERVER counted as reachable at the moment it wrote the round. The
      // fixture's apply row carries neither, and null is the honest rendering of that — never 0,
      // which would read as "nobody was reachable".
      contactableCount: null, uncontactableCount: null,
    });
  });

  it('PARTIAL drain is still a created round, with the leftover surfaced', async () => {
    const { rpc } = scriptedRpc();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn(async () => drainResult({ totalSent: 30, leftover: 10, stoppedReason: 'no_progress' })) },
      SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'created', totalSent: 30, leftover: 10, outcome: 'no_progress' });
  });

  it('a drain that ERRORS before any count → leftover null, never a fabricated 0', async () => {
    const { rpc } = scriptedRpc();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn(async () => drainResult({ leftover: null, stoppedReason: 'error', sampleError: 'boom' })) },
      SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'created', leftover: null, sampleError: 'boom' });
  });

  it('zero claims for a ZERO cohort is a COMPLETE success — there was nothing to send', async () => {
    // ROUND 3 (P3): the fixture used to pair an APPROVED five-person cohort with a zero-claim
    // receipt and bless the result. Those are two statements about one round that cannot both be
    // true, and asserting success over them hid the contradiction rather than testing anything.
    const { rpc } = scriptedRpc({ apply: [applyRow({ claim_count: 0 })] });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain },
      SESSION, { ...REVIEWED, cohortTotal: 0 });
    expect(r).toMatchObject({ phase: 'created', players: 0, totalSent: 0, leftover: 0, outcome: 'drained' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('zero claims for an APPROVED cohort is a CONTRADICTION, not a quiet success', async () => {
    const { rpc } = scriptedRpc({ apply: [applyRow({ claim_count: 0 })] });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain },
      SESSION, REVIEWED);   // five people approved
    expect(r).toMatchObject({ phase: 'unknown', reason: 'unverified_creation',
      commandId: REVIEWED.commandId });
    expect(drain, 'and nothing is drained on a receipt we do not believe').not.toHaveBeenCalled();
  });

  it('a REPLAY is never a second round — and never a second SEND either', async () => {
    // The command uuid is the idempotency key, so a retry reaching a committed command gets the
    // stored receipt back and no second round is written. That part was always true.
    //
    // `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1` corrected the other half. A replay means an
    // EARLIER apply committed, and that earlier attempt may already have drained invitations —
    // the server answers from stored bytes and re-derives nothing, so this call learns only that
    // the round exists. Draining anyway would automatically re-send provider calls whose success
    // is not durably recorded anywhere: `invited_at` is stamped AFTER the send returns, so an
    // unstamped claim is genuinely ambiguous, and the deterministic idempotency key only dedupes
    // for 24 hours.
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    const { rpc } = scriptedRpc({ apply: [applyRow({ status: 'replayed' })] });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'recovered', roundId: ROUND, via: 'replay' });
    expect(drain, 'a replay sends nothing automatically').not.toHaveBeenCalled();
  });
});

describe('createAndDrainRebookRound — proven creation failure', () => {
  it.each([
    ['a source that drifted', 'source_drift'],
    ['a round that is not there', 'round_not_found'],
    ['an intent the core will not judge', 'invalid_request'],
    ['a command already in flight', 'round_command_in_progress'],
  ])('%s is the server\'s own word, and nothing is drained', async (_label, status) => {
    const { rpc } = scriptedRpc({ apply: [applyRow({ status, round_id: null })] });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain }, SESSION, REVIEWED);
    expect(r).toEqual({ phase: 'creation_failed', reason: status });
    expect(drain).not.toHaveBeenCalled();
  });

  it('ROUND 3 (P1) · A REFUSAL FOR ANOTHER COMMAND says nothing about ours', async () => {
    // The command binding used to be checked only on the SUCCESS path, so a recognised refusal
    // carrying somebody else's command id was accepted as proof that OUR command wrote nothing —
    // and the UI then invited a fresh attempt at a round that may already exist.
    const { rpc } = scriptedRpc({
      apply: [applyRow({ status: 'source_drift', round_id: null,
        command_id: '55555555-5555-4555-8555-555555555555' })],
    });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', commandId: REVIEWED.commandId });
    expect(drain).not.toHaveBeenCalled();
  });

  it('ROUND 3 (P2) · A COMMAND-IDENTITY MISMATCH is not proof that nothing was written', async () => {
    // `command_payload_mismatch` says the STORED command differs from the one presented. When we
    // presented our own uuid, that is evidence a command under it already committed — which is
    // exactly what a retry after a lost response produces, because the created children change what
    // the selection derives.
    const { rpc } = scriptedRpc({ apply: [applyRow({ status: 'command_payload_mismatch', round_id: null })] });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn() }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', commandId: REVIEWED.commandId });
  });

  it('ROUND 3 (P2) · EVERY REAL ZERO-WRITE REFUSAL is recognised as one', async () => {
    // The hand-written list omitted nine real refusals — each reported as "may have committed" —
    // and admitted two statuses the frozen core never emits. It is derived from the shipped
    // vocabulary now, so this asserts the ones that were missing.
    for (const status of ['incoherent_source', 'review_fingerprint_mismatch', 'round_closed',
      'child_already_in_round', 'expected_version_mismatch', 'duplicate_sibling_series',
      'child_not_found', 'child_not_draft', 'round_legacy_review_required']) {
      const { rpc } = scriptedRpc({ apply: [applyRow({ status, round_id: null })] });
      const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
        { rpc, drain: vi.fn() }, SESSION, REVIEWED);
      expect(r, `${status} proves nothing was written`)
        .toEqual({ phase: 'creation_failed', reason: status });
    }
    // …and a status the core never emits is NOT believed.
    const { rpc } = scriptedRpc({ apply: [applyRow({ status: 'version_conflict', round_id: null })] });
    expect(await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn() }, SESSION, REVIEWED))
      .toMatchObject({ phase: 'unknown' });
  });

  it('a REVIEW that refuses with no occurrences never mints and never reviews again', async () => {
    const { rpc, calls } = scriptedRpc({
      probe: [resultRow({ status: 'invalid_request', occurrence_count: 0, review_fingerprint: null }),
        seriesRow(), ...rosterRowsFor('k1', 5, 1)],
    });
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
    expect(r).toEqual({ phase: 'creation_failed', reason: 'invalid_request' });
    expect(calls.map((c) => c.fn)).toEqual(['rebook_round_selection_preview_as_actor']);
  });
});

describe('createAndDrainRebookRound — a moved selection is its OWN outcome', () => {
  it('is neither unknown nor creation_failed on the review path', async () => {
    const { rpc } = scriptedRpc({ probe: [resultRow({ status: 'selection_moved' })] });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'selection_moved' });
  });

  it('is reported from the APPLY too, and KEEPS its own outcome there', async () => {
    // ROUND 1 (P2): this test used to bless `creation_failed`. Collapsing the apply's
    // `selection_moved` into a generic refusal made both wizards' dedicated recovery branches
    // unreachable — the operator got a generic error beside a review that was still on screen and
    // still armed.
    const { rpc } = scriptedRpc({ apply: [applyRow({ status: 'selection_moved', round_id: null })] });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn() }, SESSION, REVIEWED);
    expect(r).toEqual({ phase: 'selection_moved' });
  });
});

describe('createAndDrainRebookRound — everything else is UNKNOWN and drains zero', () => {
  const unknownCase = async (script: Parameters<typeof scriptedRpc>[0]) => {
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc: scriptedRpc(script).rpc, drain }, SESSION, REVIEWED);
    expect(drain).not.toHaveBeenCalled();
    return r;
  };

  it('a THROWN rpc is a result, not an exception — the round may well exist', async () => {
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, {
      rpc: vi.fn(async () => { throw new Error('network down'); }), drain,
    }, SESSION, REVIEWED);
    // The ledger was asked and could not answer either — the rpc is down for that too — so the
    // outcome says `unreadable`, which is a weaker claim than `absent` and must stay distinct
    // from it.
    expect(r).toEqual({ phase: 'unknown', reason: 'transport_error', targetCycleId: null,
      commandId: REVIEWED.commandId, recovery: 'unreadable' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('an rpc error is a transport unknown, never proof of absence', async () => {
    expect(await unknownCase({ error: { message: 'boom' } }))
      .toEqual({ phase: 'unknown', reason: 'transport_error', targetCycleId: null,
        commandId: REVIEWED.commandId, recovery: 'unreadable' });
  });

  it.each([
    ['a non-array answer', 'not-an-array'],
    ['a null answer', null],
    ['an empty array', []],
  ])('%s from the APPLY is unreadable, not proof that no round exists', async (_label, apply) => {
    expect(await unknownCase({ apply })).toMatchObject({ phase: 'unknown' });
  });

  it.each([
    ['a non-array answer', 'not-an-array'],
    ['a null answer', null],
    ['an array with no result row', [seriesRow()]],
  ])('%s from a COUNT is unreadable, not an empty selection', async (_label, probe) => {
    const { rpc } = scriptedRpc({ probe });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'counts'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('an APPLY answer with a drifted round id is UNVERIFIED, never a success', async () => {
    // A SYNTACTICALLY INVALID id, and — the case that actually mattered — a perfectly VALID id for
    // a DIFFERENT round. Round 1 of the closure review found the second one accepted: the decoder
    // checked only that the value parsed as a uuid, so an answer about somebody else's round was
    // read as an answer about ours.
    for (const drifted of ['not-a-uuid', '99999999-9999-4999-8999-999999999999']) {
      expect(await unknownCase({ apply: [applyRow({ round_id: drifted })] }),
        `${drifted} is not our round`)
        .toEqual({ phase: 'unknown', reason: 'transport_error', targetCycleId: null,
          commandId: REVIEWED.commandId, recovery: 'not_visible' });
    }
  });

  it('an APPLY that reports success with NO children is unverified', async () => {
    // There is nothing to navigate to and nothing to drain, so this cannot be called created —
    // and it is not proof of absence either.
    expect(await unknownCase({ apply: [applyRow({ child_cycle_ids: [], child_count: 0 })] }))
      .toEqual({ phase: 'unknown', reason: 'unverified_creation', targetCycleId: null });
  });

  it.each([
    ['a child id that is not a uuid', { child_cycle_ids: [CY1, 'oops'] }],
    ['a count that disagrees with the ids', { child_cycle_ids: [CY1], child_count: 2 }],
    ['a stringified claim count', { claim_count: '40' }],
    ['a fractional child count', { child_count: 1.5 }],
  ])('DECODE IS STRICT: %s makes the whole answer unverified', async (_label, over) => {
    // ROUND 1 (P2): this used to DROP the unreadable child and drain the valid subset — a
    // confident success assembled from a body we could not read. A row that does not decode
    // cleanly is `unknown`: the command may well have committed, and the uuid is the handle.
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: scriptedRpc({ apply: [applyRow(over)] }).rpc, drain }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', commandId: REVIEWED.commandId });
    expect(drain, 'nothing is drained against an answer we could not read').not.toHaveBeenCalled();
  });
});

describe('previewRebookRound — the same decode, on the dry-run path', () => {
  it('COUNTS asks the counting projection and returns the shape the review table renders', async () => {
    const { rpc, calls } = scriptedRpc({
      probe: [resultRow({ status: 'counted', review_fingerprint: null }), seriesRow()],
    });
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'counts');
    expect(calls[0].args.p_projection).toBe('counts');
    expect(r).toMatchObject({ phase: 'preview', selectionDigest: '\\xd19657' });
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect(r.body).toMatchObject({ groups: 1, players: 5, suggestedWeeks: 8 });
    expect((r.body.groupsDetail as unknown[])).toHaveLength(1);
  });

  it('REVIEW asks the reviewing projection, and the digest is echoed on the next call', async () => {
    const { rpc, calls } = scriptedRpc();
    await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid },
      { roundId: ROUND, selectionDigest: '\\xdeadbeef' }, 'review');
    expect(calls[0].args.p_projection).toBe('review');
    expect(calls[0].args.p_selection_digest).toBe('\\xdeadbeef');
  });

  it('a MOVED selection is its own phase on the preview path too', async () => {
    const { rpc } = scriptedRpc({ probe: [resultRow({ status: 'selection_moved' })] });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'counts'))
      .toEqual({ phase: 'selection_moved' });
  });

  it('a REFUSED selection is unknown — this client cannot tell the closed refusals apart', async () => {
    const { rpc } = scriptedRpc({ probe: [resultRow({ status: 'refused', review_fingerprint: null })] });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'counts'))
      .toEqual({ phase: 'unknown', reason: 'unverified_creation' });
  });

  it('an unreadable answer is unknown, not an empty preview', async () => {
    const { rpc } = scriptedRpc({ probe: 'nope' });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'counts'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('a body that cannot describe a round at all never reaches the server', async () => {
    const { rpc, calls } = scriptedRpc();
    expect(await previewRebookRound({}, { rpc, newUuid }, SESSION, 'counts'))
      .toEqual({ phase: 'unknown', reason: 'unverified_creation' });
    expect(calls, 'no academy, no call').toHaveLength(0);
  });

  it('an ABORTED request reports `aborted` — it must not clear the newer request authority', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await previewRebookRound({ academyProfileId: CY1 }, {
      rpc: vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }),
      newUuid,
      signal: ac.signal,
    }, SESSION, 'counts');
    expect(r).toEqual({ phase: 'aborted' });
  });

  it('a request that RESOLVES after being aborted is still `aborted`', async () => {
    const ac = new AbortController();
    const r = await previewRebookRound({ academyProfileId: CY1 }, {
      rpc: vi.fn(async () => { ac.abort(); return { data: [resultRow()], error: null }; }),
      newUuid,
      signal: ac.signal,
    }, SESSION, 'counts');
    expect(r).toEqual({ phase: 'aborted' });
  });
});

describe('defaultSender-shaped decoding — a chunk we cannot read is UNKNOWN, not zero', () => {
  it('a chunk result with NaN counts never reaches the totals', async () => {
    // The drain treats a throwing sender as `error`, which forces leftover to null (unknown).
    const sender = vi.fn(async () => { throw new Error('send_chunk_unreadable'); });
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.leftover).toBeNull();
    expect(Number.isNaN(r.totalSent)).toBe(false);
    expect(r.totalSent).toBe(0);
  });
});

// ── ROUND 1 · WHAT THE FIRST ADVERSARIAL PASS FOUND ON THE CLIENT ───────────────────────────
//
// One test per defect. Each failed before its fix.

describe('round-1 corrections — the send is never armed against an intent the server refuses', () => {
  it('P1 · A SESSION PRICE makes the intent apply-INELIGIBLE, and the send is withheld', async () => {
    // ABC-27 marks ANY non-null session price `refused_session_price` and refuses it at apply.
    // The driver used to discard `apply_eligibility` entirely, so a priced round previewed green,
    // armed the send, and then failed deterministically. Both wizards have a price field and both
    // PREFILL it from the source term, which makes this the ordinary case.
    const { rpc } = scriptedRpc({
      review: [resultRow({ apply_eligibility: 'refused_session_price' }), seriesRow(),
        ...rosterRowsFor('k1', 5, 1)],
    });
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
    expect(r).toMatchObject({ phase: 'not_permitted', reason: 'session_price' });
    // ROUND 2 (P2): THE REVIEW COMES WITH IT. The mitigation is that the operator sees the review
    // and the SEND is withheld; discarding the body made that claim false.
    if (r.phase !== 'not_permitted') throw new Error('unreachable');
    expect(r.body, 'the review is still shown').toMatchObject({ groups: 1, players: 5 });
  });

  it('P1 · AN APPROVED, ELIGIBLE review still yields the send authority', async () => {
    // The control that stops the assertion above from passing for the wrong reason.
    const { rpc } = scriptedRpc();
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
    expect(r.phase).toBe('preview');
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect(r.reviewed).not.toBeNull();
  });

  it('P1 · AN EXTEND WHOSE VERSION THE SERVER CANNOT RESOLVE says so, not "we could not confirm"', async () => {
    // OD3 changed WHEN this fires, not whether. The server now resolves `rebook_rounds.version`
    // for an extend and returns it, so an extend is attempted — but a round the server returns no
    // version for is still one this browser cannot fence, and the caller knows it asked to extend.
    // Reporting that as `unknown` would be a worse answer than naming it.
    const { rpc } = scriptedRpc({
      probe: [resultRow({ status: 'invalid_request', review_fingerprint: null, round_version: null }),
        seriesRow(), ...rosterRowsFor('k1', 5, 1)],
    });
    const r = await previewRebookRound(
      { academyProfileId: CY1, extendRoundId: ROUND }, { rpc, newUuid }, SESSION, 'review');
    expect(r).toEqual({ phase: 'not_permitted', reason: 'extend_unavailable' });
  });

  it('OD3 · AN EXTEND PROBES TWICE: once to learn the version, once carrying it', async () => {
    // CLOSURE REVIEW ROUND 2 (P1) — THIS FIXTURE WAS IMPOSSIBLE, AND IT HID A BROKEN FEATURE.
    //
    // It scripted a probe with `occurrence_count: 8` beside a null-version refusal. No server can
    // answer that: the core refuses `extend` with a null `p_expected_version` BEFORE deriving any
    // occurrence (frozen ABC-27 `:15728`), so the real refusal carries ZERO. The driver exits on
    // zero occurrences, so it never reached the version the wrapper had returned — and no extend
    // could be previewed at all. The feature was shipped not working and this test said it worked.
    //
    // The real sequence, pinned end-to-end against a live core in `d7RuntimeContract`
    // ("A REAL CREATE-THEN-EXTEND"): refusal-with-version, then a second probe carrying it.
    let probes = 0;
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'rebook_round_selection_preview_as_actor') return { data: [applyRow()], error: null };
      const minted = (args.p_target_slot_ids as unknown[] | null) ?? [];
      if (minted.length > 0) {
        return { data: [resultRow({ round_version: 7 }), seriesRow(), ...rosterRowsFor('k1', 5, 1)],
          error: null };
      }
      probes += 1;
      // FIRST probe: no version stated, so the core derives nothing — and the wrapper discloses
      // the version anyway, which is the only reason the second probe is possible.
      if (args.p_expected_version == null) {
        // THE SERIES AND ROSTER ROWS COME TOO. The wrapper emits them whatever the core's verdict
        // — they are its own projection, not the core's — so a fixture shipping a lone result row
        // is one the decoder's rowset reconciliation refuses, and the case would fail for a reason
        // that has nothing to do with versions.
        return { data: [resultRow({ status: 'invalid_request', review_fingerprint: null,
          selection_digest: null, occurrence_count: 0, round_version: 7 }),
        seriesRow(), ...rosterRowsFor('k1', 5, 1)], error: null };
      }
      // SECOND probe: fenced, so the pool is derived.
      return { data: [resultRow({ status: 'invalid_request', review_fingerprint: null,
        round_version: 7 }), seriesRow(), ...rosterRowsFor('k1', 5, 1)], error: null };
    });

    const r = await previewRebookRound(
      { academyProfileId: CY1, extendRoundId: ROUND }, { rpc, newUuid }, SESSION, 'review');
    expect(r.phase, 'the extend is reviewed, not refused out of hand').toBe('preview');
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect(probes, 'it probed twice — the first answer only carried the version').toBe(2);
    expect(r.reviewed?.expectedVersion, 'the review is fenced on the version the server resolved')
      .toBe(7);
    const armed = (rpc.mock.calls as Array<[string, Record<string, unknown>]>)
      .filter(([fn, a]) => fn === 'rebook_round_selection_preview_as_actor'
        && ((a.p_target_slot_ids as unknown[] | null) ?? []).length > 0).at(-1)!;
    expect(armed[1].p_expected_version,
      'and the armed review states it — the browser never invents one').toBe(7);
  });

  it('OD3 · AN EXTEND THE SERVER WILL NOT VERSION is refused, not sent', async () => {
    const rpc = vi.fn(async () => ({
      data: [resultRow({ status: 'invalid_request', review_fingerprint: null,
        selection_digest: null, occurrence_count: 0, round_version: null }),
      seriesRow(), ...rosterRowsFor('k1', 5, 1)],
      error: null,
    }));
    expect(await previewRebookRound(
      { academyProfileId: CY1, extendRoundId: ROUND }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'not_permitted', reason: 'extend_unavailable' });
  });

  it('P1 · a CREATE refused the same way stays `unknown` — this client may not guess', async () => {
    const { rpc } = scriptedRpc({ probe: [resultRow({ status: 'refused', review_fingerprint: null })] });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'unknown', reason: 'unverified_creation' });
  });
});

// ── D7 CLOSURE · THE DECODER MEETS THE SHAPES THE SERVER ACTUALLY SENDS ─────────────────────

describe('readChunkResponse — the sender\'s real terminal answers', () => {
  // REVIEW ROUND 1 (P2). Every other test in this file injects a FAKE sender whose fixture helper
  // fills all six fields, so the decoder had never been shown a real response. The sender has three
  // branches that return `{sent, skipped, remaining}` and nothing else, and each of them was being
  // read as an unreadable chunk — turning "there is nothing left to send" into "the delivery was
  // interrupted". Recovery makes that the COMMON case: a recovered round is usually one whose
  // invitations already went out.
  it.each([
    ['no drainable representatives', { sent: 0, skipped: 0, remaining: 0, attempted: 0 }],
    ['no claims at all', { sent: 0, skipped: 0, remaining: 0, attempted: 0 }],
    ['every claim already invited', { sent: 0, skipped: 3, remaining: 0, attempted: 0 }],
  ])('accepts the terminal answer for %s', (_label, body) => {
    const r = readChunkResponse(body as Record<string, unknown>);
    expect(r).toEqual({
      sent: 0, failed: 0, already: 0, suppressed: 0, held: 0, unstamped: 0, attempted: 0, remaining: 0,
      failedClaimIds: [], unresolvedClaimIds: [], sampleError: null,
    });
  });

  it('still refuses a field that is PRESENT and mistyped', () => {
    // The distinction that keeps this from being a weakening: absent means the server did not say,
    // and zero is what those branches mean. A wrong TYPE is the server saying something we cannot
    // read, and that is still an unknown outcome.
    for (const bad of [
      { sent: 0, remaining: 0, failed: '2', attempted: 0 },
      { sent: 0, remaining: 0, held: -1 },
      { sent: 0, remaining: 0, failedClaimIds: 'nope', attempted: 0 },
      { sent: 0, remaining: 0, needsAttentionClaimIds: [1, 2] },
      { sent: '4', remaining: 0, attempted: 0 },
      { sent: 0, attempted: 0 },
    ]) {
      expect(() => readChunkResponse(bad as Record<string, unknown>),
        JSON.stringify(bad)).toThrow('send_chunk_unreadable');
    }
  });

  it('reads a full answer exactly as before', () => {
    expect(readChunkResponse({
      sent: 4, failed: 1, held: 2, unstamped: 1, remaining: 7,
      failedClaimIds: ['a'], needsAttentionClaimIds: ['b'], sampleError: 'boom',
    })).toEqual({
      sent: 4, failed: 1, already: 0, suppressed: 0, held: 2, unstamped: 1, attempted: 8, remaining: 7,
      failedClaimIds: ['a'], unresolvedClaimIds: ['b'], sampleError: 'boom',
    });
  });

  it('an older endpoint that reports no overlap is read as no overlap', () => {
    // `unstamped` is new (review round 5). A response without it must not become NaN arithmetic in
    // the drain — an absent overlap is a zero overlap, which is also the pre-existing behaviour.
    expect(readChunkResponse({
      sent: 4, failed: 1, held: 2, remaining: 7,
      failedClaimIds: ['a'], unresolvedClaimIds: ['b'], sampleError: null,
    })?.unstamped, 'absent means zero').toBe(0);
  });
});

// ── D7 TERMINAL CLOSURE · RECOVERING A LOST APPLY RESPONSE ──────────────────────────────────

/** The exact bytes the server froze, and a REAL sha256 over them — never a placeholder digest. */
async function ledgerFound(over: Record<string, unknown> = {}, mutateBytes = false) {
  // `receipt` STEERS THE PAYLOAD; IT IS NOT A COLUMN.
  //
  // It used to be spread into the row along with everything else, which added a stray `receipt`
  // key — and `hasExactKeys` then rejected the whole row. Any case passing a receipt override was
  // therefore passing because the row was MALFORMED, not because of the property it was written
  // for; the mutation battery caught it when disabling the round pin changed nothing.
  const { receipt: receiptOver, ...rowOver } = over;
  const receipt = {
    v: 'abc27.receipt.v1',
    kind: 'create',
    roundId: ROUND,
    commandId: REVIEWED.commandId,
    children: [CY1, CY2],
    count: 2,
    occurrenceCount: 8,
    claimCount: 40,
    ...(receiptOver as Record<string, unknown> ?? {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const hex = (b: Uint8Array) => `\\x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  // THE TAMPER MUST LEAVE VALID JSON, OR IT PROVES THE WRONG THING.
  //
  // The first version flipped the final byte — the closing brace — so `JSON.parse` threw and the
  // test passed without the digest check ever mattering. Mutating the battery confirmed it: the
  // case stayed green with the comparison disabled. Changing a DIGIT keeps the document
  // well-formed and every structural check satisfied, so the only thing standing between these
  // bytes and a confident drain is the hash.
  const shipped = mutateBytes
    ? new TextEncoder().encode(JSON.stringify({ ...receipt, claimCount: 41 }))
    : bytes;
  return [{
    status: 'found',
    command_kind: 'create',
    round_id: ROUND,
    command_id: REVIEWED.commandId,
    receipt_canonical: hex(shipped),
    receipt_digest: hex(digest),
    applied_at: '2026-08-27T09:00:00Z',
    ...rowOver,
  }];
}

describe('D7 closure — a lost apply response is recovered, never re-minted', () => {
  it('P1 · A LOST RESPONSE is resolved from the ledger, and NOTHING is sent', async () => {
    // The apply committed and the answer never came back. Before this, the operator got `unknown`,
    // a command uuid rendered as inert text, and no way to act on it — while the ledger had held
    // the complete receipt, actor-scoped and already granted to `authenticated`, the entire time.
    //
    // `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`: resolving it is the useful half; draining it is
    // the dangerous half. An earlier attempt may already have mailed these players and nothing
    // durable records whether it did, so this reports and stops.
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    const { rpc, calls } = scriptedRpc({ error: undefined, recover: await ledgerFound() });
    // The apply itself answers unreadably; recovery is what decides the outcome.
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'rebook_round_selection_apply_as_actor') return { data: 'nonsense', error: null };
        return rpc(fn, args);
      }), drain }, SESSION, REVIEWED);

    expect(r).toMatchObject({ phase: 'recovered', roundId: ROUND, targetCycleId: CY1, via: 'ledger' });
    expect(drain, 'the round is REPORTED, never re-sent').not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === 'rebook_round_selection_apply_as_actor'),
      'and NO second command was ever applied').toBe(false);
  });

  it('P1 · A RECOVERED ROUND names itself so the operator can go and reconcile', async () => {
    // It used to be asserted that a recovered round carried NO contact count — true, and now
    // beside the point: it carries no send at all. What it must carry is enough for a person to
    // finish the job by hand: the round, and the cycle to open.
    const { rpc } = scriptedRpc({ recover: await ledgerFound() });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'rebook_round_selection_apply_as_actor') return { data: 'nonsense', error: null };
        return rpc(fn, args);
      }), drain: vi.fn(async () => drainResult({ totalSent: 40 })) }, SESSION, REVIEWED);
    if (r.phase !== 'recovered') throw new Error('unreachable');
    expect(r.roundId).toBe(ROUND);
    expect(r.targetCycleId, 'the cycle to open').toBe(CY1);
    expect(r.groups).toBe(2);
    expect(r.commandId, 'and the command it was resolved under').toBe(REVIEWED.commandId);
  });

  it('BLOCKER · NO PATH THAT COULD REPEAT A PROVIDER SEND drains automatically', async () => {
    // `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`, stated as one property over every entry point.
    //
    // A provider send is durably recorded ONLY by `slot_priority_claims.invited_at`, which is
    // stamped after the send returns. So an unstamped claim is genuinely ambiguous — never sent, or
    // sent with a failed stamp — and the sole protection against a duplicate is the deterministic
    // idempotency key, which the provider honours for 24 hours. Any automatic re-send outside that
    // window is a duplicate email to a real person.
    //
    // The three ways to reach a round somebody else's attempt may already have mailed:
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    const cases: Array<[string, Parameters<typeof scriptedRpc>[0]]> = [
      ['the server replayed an earlier command',
        { apply: [applyRow({ status: 'replayed' })] }],
      ['a lost response was resolved from the ledger',
        { apply: 'nonsense', recover: await ledgerFound() }],
      ['the duplicate-intent refusal pointed at an earlier command',
        { apply: [applyRow({ status: 'invalid_request', round_id: null, child_cycle_ids: null })],
          recover: await ledgerFound() }],
    ];
    for (const [label, script] of cases) {
      drain.mockClear();
      const { rpc } = scriptedRpc(script);
      const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
        { rpc, drain }, SESSION, REVIEWED);
      expect(r.phase, label).toBe('recovered');
      expect(drain, `${label}: nothing is sent automatically`).not.toHaveBeenCalled();
    }
  });

  it('a FIRST, ACKNOWLEDGED apply still drains — the ambiguity is what stops a send, not caution', async () => {
    // The control that keeps the rule above from being satisfied by simply never sending anything.
    // A round this call just created cannot have a prior provider effect: no earlier command
    // committed it, so no earlier attempt can have mailed anyone.
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    const { rpc } = scriptedRpc();
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain },
      SESSION, REVIEWED);
    expect(r.phase).toBe('created');
    expect(drain, 'the first send of a freshly written round is not ambiguous').toHaveBeenCalled();
  });

  it('P1 · A TAMPERED RECEIPT is never trusted, and never drained against', async () => {
    const drain = vi.fn();
    const { rpc } = scriptedRpc({ recover: await ledgerFound({}, true) });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'rebook_round_selection_apply_as_actor') return { data: 'nonsense', error: null };
        return rpc(fn, args);
      }), drain }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', recovery: 'unreadable' });
    expect(drain, 'bytes that do not hash to their own digest buy nothing').not.toHaveBeenCalled();
  });

  it('P1 · A RECEIPT FOR A DIFFERENT ROUND, wholly self-consistent, is still refused', async () => {
    // THE CASE THE OTHER TEST DOES NOT COVER. That one mutates the receipt so it disagrees with the
    // ledger row — internal inconsistency, which the hash and the id checks catch. This one is a
    // COHERENT receipt for an older command of the same actor in the same academy: row and receipt
    // agree with each other perfectly, every cryptographic check passes, and it is simply not the
    // round this client reviewed. A stale or reused command uuid reaches exactly this, and before
    // round 1 of the closure review it would have been drained against the older round's children.
    const other = '99999999-9999-4999-8999-999999999999';
    const drain = vi.fn();
    const { rpc } = scriptedRpc({
      recover: await ledgerFound({ round_id: other, receipt: { roundId: other } }),
    });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'rebook_round_selection_apply_as_actor') return { data: 'nonsense', error: null };
        return rpc(fn, args);
      }), drain }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', recovery: 'unreadable' });
    expect(drain, 'somebody else\'s round is never drained').not.toHaveBeenCalled();
  });

  it('P1 · A RECEIPT ABOUT ANOTHER ROUND is refused, however well-formed', async () => {
    const { rpc } = scriptedRpc({ recover: await ledgerFound({ receipt: { roundId: CY2 } }) });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'rebook_round_selection_apply_as_actor') return { data: 'nonsense', error: null };
        return rpc(fn, args);
      }), drain: vi.fn() }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', recovery: 'unreadable' });
  });

  it('P1 · THE DUPLICATE-INTENT REFUSAL is a recovery signal, not a failure', async () => {
    // `uq_rebook_round_commands_actor_review` makes one actor's reviewed intent applicable exactly
    // once, and the writer's own refusal detail says so: "recover it by review fingerprint". A
    // round WAS created, under a uuid this tab never saw — reporting `creation_failed` told the
    // operator the opposite of the truth and invited them to make a second one.
    const drain = vi.fn(async () => drainResult({ totalSent: 40 }));
    const { rpc } = scriptedRpc({
      apply: [applyRow({ status: 'invalid_request', round_id: null, child_cycle_ids: null })],
      recover: await ledgerFound(),
    });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain }, SESSION, REVIEWED);
    // The operator learns the round EXISTS — the opposite of the `creation_failed` they used to be
    // told — and, per `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`, nothing is mailed on their
    // behalf by a path that cannot know what the earlier attempt already sent.
    expect(r).toMatchObject({ phase: 'recovered', roundId: ROUND, via: 'ledger' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('P1 · AN ORDINARY invalid_request still reports the server\'s own word', async () => {
    // …and the ledger is what tells the two apart. When it says `absent`, the refusal really was
    // an ordinary one and is reported verbatim rather than dressed up as an unknown.
    const { rpc } = scriptedRpc({
      apply: [applyRow({ status: 'invalid_request', round_id: null, child_cycle_ids: null })],
    });
    expect(await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain: vi.fn() },
      SESSION, REVIEWED)).toEqual({ phase: 'creation_failed', reason: 'invalid_request' });
  });

  it('P2 · AN invalid_request THE LEDGER CANNOT ANSWER stays unknown, not a proven failure', async () => {
    // `invalid_request` is genuinely AMBIGUOUS after this change: it is the ordinary typed refusal
    // AND the duplicate-intent one that means a round already exists under another uuid. Only the
    // ledger tells them apart, so when the ledger cannot be read, neither can this — and claiming
    // "nothing was created" would be the same false confidence in the opposite direction that the
    // whole `unknown` vocabulary exists to avoid.
    const { rpc } = scriptedRpc({
      apply: [applyRow({ status: 'invalid_request', round_id: null, child_cycle_ids: null })],
      recover: 'not-an-array',
    });
    expect(await createAndDrainRebookRound({ academyProfileId: CY1 }, { rpc, drain: vi.fn() },
      SESSION, REVIEWED))
      .toMatchObject({ phase: 'unknown', reason: 'unverified_creation', recovery: 'unreadable' });
  });

  it('P1 · BOTH HANDLES ARE TRIED, and neither refusing is treated as proof', async () => {
    const { rpc, calls } = scriptedRpc({ apply: 'nonsense' });
    const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn() }, SESSION, REVIEWED);
    expect(r).toMatchObject({ phase: 'unknown', recovery: 'not_visible' });
    const asked = calls.map((c) => c.fn);
    expect(asked).toContain('rebook_round_command_status_as_actor');
    expect(asked, 'the fingerprint handle is tried when the uuid finds nothing')
      .toContain('rebook_round_command_lookup_by_review_as_actor');
  });

  it('P2 · RECOVERY IS READ-ONLY: it never applies, and never mints a command', async () => {
    const { rpc, calls } = scriptedRpc({ apply: 'nonsense', recover: await ledgerFound() });
    await createAndDrainRebookRound({ academyProfileId: CY1 },
      { rpc, drain: vi.fn(async () => drainResult({ totalSent: 1 })) }, SESSION, REVIEWED);
    const applies = calls.filter((c) => c.fn === 'rebook_round_selection_apply_as_actor');
    expect(applies, 'exactly the one apply that was already sent').toHaveLength(1);
    expect(applies[0].args.p_command_id, 'under the command uuid we already had')
      .toBe(REVIEWED.commandId);
  });
});

// ── ROUND 5 · WHAT THE FIFTH AND FINAL ADVERSARIAL PASS FOUND ───────────────────────────────

describe('round-5 corrections — the reconciliation counted names, and the headline counted wrong', () => {
  it('P1 · TWO PEOPLE WITH ONE NAME are a valid cohort, not a truncated answer', async () => {
    // ROUND 4 REGRESSED THIS. It keyed the reconciliation on `(series_key, display_name)`, but the
    // server counts recipient KEYS and two players are allowed to share a name. Two "Jan de Vries"
    // collapsed into one set entry, the answer was declared unreadable, and a legitimate round
    // could not be sent at all by either wizard.
    const { rpc } = scriptedRpc({
      review: [resultRow({ cohort_total: 2, no_email_total: 0, total_sessions: 16 }),
        seriesRow({ subject_count: 2, no_email_count: 0 }),
        { row_kind: 'roster', series_key: 'k1', display_name: 'Jan de Vries', has_email: true },
        { row_kind: 'roster', series_key: 'k1', display_name: 'Jan de Vries', has_email: true }],
    });
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
    expect(r.phase, 'a shared name is not a duplicate row').toBe('preview');
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect((r.body as { groupsDetail: Array<{ roster: unknown[] }> }).groupsDetail[0].roster,
      'and BOTH people are rendered').toHaveLength(2);
  });

  it('P1 · TWO NAMELESS PLAYERS, both rendered the same placeholder, are still two people', async () => {
    // The counts describe the roster: one of the two has no address. An earlier version of this
    // fixture said `no_email_count: 0` beside a roster row with `has_email: false`, which the
    // closure's contact reconciliation now refuses — correctly, because no single instant produced
    // it. The fixture was wrong, not the check.
    const { rpc } = scriptedRpc({
      review: [resultRow({ cohort_total: 2, no_email_total: 1, total_sessions: 16 }),
        seriesRow({ subject_count: 2, no_email_count: 1 }),
        { row_kind: 'roster', series_key: 'k1', display_name: '\u2014', has_email: true },
        { row_kind: 'roster', series_key: 'k1', display_name: '\u2014', has_email: false }],
    });
    expect((await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review')).phase)
      .toBe('preview');
  });

  it('P2 · AN ANSWER THAT CONTRADICTS ITSELF ON CONTACTS is unreadable, however well-sized', async () => {
    // REVIEW ROUND 1 (P2) OF THE CLOSURE. The wrapper is VOLATILE under READ COMMITTED and reads
    // the totals, the per-series counts and the roster in SEPARATE statements, so an address added
    // between two of them yields an answer no single instant produced. Cardinality cannot see it:
    // every row is present and every count of ROWS agrees. What disagrees is who is reachable.
    //
    // Left uncaught, the operator is asked to acknowledge an unreachable player the list does not
    // contain — or, in the other direction, is not asked at all while the list shows one.
    const cases: Array<[string, Record<string, unknown>[]]> = [
      ['a series claiming an unreachable player the roster does not have',
        [resultRow({ cohort_total: 2, no_email_total: 1, total_sessions: 16 }),
          seriesRow({ subject_count: 2, no_email_count: 1 }),
          ...rosterRowsFor('k1', 2, 0)]],
      ['a roster showing one the series does not count',
        [resultRow({ cohort_total: 2, no_email_total: 0, total_sessions: 16 }),
          seriesRow({ subject_count: 2, no_email_count: 0 }),
          ...rosterRowsFor('k1', 2, 1)]],
      ['a headline total that disagrees with its own series',
        [resultRow({ cohort_total: 2, no_email_total: 2, total_sessions: 16 }),
          seriesRow({ subject_count: 2, no_email_count: 1 }),
          ...rosterRowsFor('k1', 2, 1)]],
    ];
    for (const [label, review] of cases) {
      const { rpc } = scriptedRpc({ review });
      expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'),
        label).toEqual({ phase: 'unknown', reason: 'unreadable_response' });
    }
  });

  it('P1 · A WHOLLY MISSING ROSTER never arms a send', async () => {
    // The shape a row cap is most likely to produce: the result row and the series rows come first
    // and are few, so the cut lands after them and every roster row is lost. Round 4 skipped its
    // check entirely when the roster was empty, so `child_count` still agreed and the operator
    // armed a send having been shown nobody at all.
    const { rpc } = scriptedRpc({
      review: [resultRow({ cohort_total: 5 }), seriesRow({ subject_count: 5 })],
    });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('P1 · A ROSTER THAT LANDS IN THE WRONG SERIES is unreadable, though the total agrees', async () => {
    const { rpc } = scriptedRpc({
      review: [resultRow({ child_count: 2, cohort_total: 2, no_email_total: 0, total_sessions: 16 }),
        seriesRow({ subject_count: 1, no_email_count: 0 }),
        seriesRow({ series_key: 'k2', child_cycle_id: CY2, subject_count: 1, no_email_count: 0 }),
        ...rosterRowsFor('k1', 2)],
    });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('P2 · A HEADLINE COUNT THE SERIES CANNOT SUPPORT is refused in both directions', async () => {
    // `cohort_total` counts a person once across the included series, so it can be neither more
    // than their summed subjects nor less than the largest single one.
    const tooMany = scriptedRpc({
      review: [resultRow({ cohort_total: 6 }), seriesRow({ subject_count: 5 }), ...rosterRowsFor('k1', 5, 1)],
    });
    expect((await previewRebookRound({ academyProfileId: CY1 }, { rpc: tooMany.rpc, newUuid }, SESSION, 'review')).phase)
      .toBe('unknown');
    const tooFew = scriptedRpc({
      review: [resultRow({ cohort_total: 4 }), seriesRow({ subject_count: 5 }), ...rosterRowsFor('k1', 5, 1)],
    });
    expect((await previewRebookRound({ academyProfileId: CY1 }, { rpc: tooFew.rpc, newUuid }, SESSION, 'review')).phase)
      .toBe('unknown');
  });

  it('P1 · THE INVITATION COUNT IS WHAT THE DRAIN WILL SEND, not a deduped headcount', async () => {
    // Alice books two of the included groups. `cohort_total` counts her ONCE, but the drain runs
    // per child cycle and the sender picks one recipient per (series, player), so she is mailed
    // twice. The old `players - noEmailTotal` arithmetic offered to "send 1 invitation".
    const { rpc } = scriptedRpc({
      review: [resultRow({ child_count: 2, cohort_total: 1, no_email_total: 0, total_sessions: 16 }),
        seriesRow({ subject_count: 1, no_email_count: 0 }),
        seriesRow({ series_key: 'k2', child_cycle_id: CY2, subject_count: 1, no_email_count: 0 }),
        ...rosterRowsFor('k1', 1), ...rosterRowsFor('k2', 1)],
    });
    const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
    if (r.phase !== 'preview') throw new Error('unreachable');
    expect((r.body as { players: number }).players, 'the headcount still counts her once').toBe(1);
    expect((r.body as { emailInvitationTotal: number }).emailInvitationTotal,
      'but TWO invitations are what this send authorizes').toBe(2);
  });

  it('P2 · A TYPED PRICE OVERRIDE is what each row states, so price x sessions is its own total', async () => {
    const { rpc } = scriptedRpc();
    const r = await previewRebookRound(
      { academyProfileId: CY1, sessionPrice: 30 }, { rpc, newUuid }, SESSION, 'review');
    // The override makes the round apply-ineligible, but the REVIEW is still rendered, and the
    // server computes `invoice_total` from the override while reporting the template as
    // `source_price` — so the row used to state a price that did not multiply out to its own total.
    const body = r.phase === 'not_permitted' ? r.body : (r.phase === 'preview' ? r.body : null);
    const detail = (body as { groupsDetail: Array<{ pricePerSession: number | null }> }).groupsDetail[0];
    expect(detail.pricePerSession).toBe(30);
  });
});

// ── ROUND 4 · WHAT THE FOURTH ADVERSARIAL PASS FOUND ────────────────────────────────────────

describe('round-4 corrections — a truncated answer, a weak fingerprint, and the full refusal set', () => {
  it('P1 · A TRUNCATED ROWSET is unreadable, not a shorter review', async () => {
    // PostgREST caps rows and the hosted cap is not pinned anywhere in this repo. Five groups of
    // two hundred players is over a thousand rows, so a truncated answer arrives looking perfectly
    // well formed — same result row, shorter roster — while the apply creates claims for everyone.
    const { rpc } = scriptedRpc({
      review: [resultRow({ cohort_total: 5 }), seriesRow({ subject_count: 5 }),
        { row_kind: 'roster', series_key: 'k1', display_name: 'A', has_email: true }],
    });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('P1 · A MISSING SERIES ROW is unreadable too, even with the roster intact', async () => {
    const { rpc } = scriptedRpc({
      review: [resultRow({ child_count: 2 }), seriesRow(), rosterRowFor('k1')],
    });
    expect(await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review'))
      .toEqual({ phase: 'unknown', reason: 'unreadable_response' });
  });

  it('P3 · A FINGERPRINT THAT NO SERVER COULD PRODUCE does not arm a send', async () => {
    // The repo ships an exact 32-octet validator for this value; the driver was accepting any
    // non-empty string, and the fixtures were quietly normalising four-byte fingerprints.
    for (const fp of ['\\x0badc0de', '\\xzz', 'not-bytea', '\\x' + 'ab'.repeat(31)]) {
      const { rpc } = scriptedRpc({ review: [resultRow({ review_fingerprint: fp }), seriesRow(), rosterRowFor('k1')] });
      const r = await previewRebookRound({ academyProfileId: CY1 }, { rpc, newUuid }, SESSION, 'review');
      expect(r.phase, `${fp} must not arm a send`).not.toBe('preview');
    }
  });

  it('P3 · THE NO-WRITE-PROOF SET IS PINNED, in both directions', async () => {
    // Re-admitting a command-identity mismatch, or dropping the wrapper's own `refused`, would
    // otherwise stay green — the previous matrix sampled a handful of statuses.
    const proves = async (status: string) => {
      const { rpc } = scriptedRpc({ apply: [applyRow({ status, round_id: null })] });
      const r = await createAndDrainRebookRound({ academyProfileId: CY1 },
        { rpc, drain: vi.fn() }, SESSION, REVIEWED);
      return r.phase === 'creation_failed';
    };
    for (const s of ['refused', 'session_price_refused', 'invalid_request', 'source_drift',
      'round_not_found', 'round_closed', 'round_legacy_review_required', 'round_command_in_progress',
      'child_not_found', 'child_not_draft', 'child_already_in_round', 'duplicate_sibling_series',
      'expected_version_mismatch', 'incoherent_source', 'review_fingerprint_mismatch']) {
      expect(await proves(s), `${s} proves nothing was written`).toBe(true);
    }
    for (const s of ['command_payload_mismatch', 'command_kind_mismatch', 'command_tenant_mismatch',
      'version_conflict', 'lifecycle_conflict', 'anything_else']) {
      expect(await proves(s), `${s} must NOT be read as proof`).toBe(false);
    }
  });
});

/** The ledger's closed refusal: no command under this handle, for this actor. */
function refusedLedgerRow() {
  return {
    status: 'refused', command_kind: null, round_id: null, command_id: null,
    receipt_canonical: null, receipt_digest: null, applied_at: null,
  } as Record<string, unknown>;
}

/** One roster row, for a fixture that needs a matching subject. */
function rosterRowFor(key: string) {
  return { row_kind: 'roster', series_key: key, display_name: 'A', has_email: true };
}

/**
 * `n` roster rows for one series, `noEmail` of them without an address.
 *
 * The server emits exactly one row per recipient KEY, so a faithful fixture ships as many rows as
 * the series claims subjects — and it deliberately repeats a display name, because two people are
 * allowed to share one and round 4's name-keyed reconciliation refused exactly that.
 */
function rosterRowsFor(key: string, n: number, noEmail = 0) {
  return Array.from({ length: n }, (_, i) => ({
    row_kind: 'roster',
    series_key: key,
    display_name: i < 2 ? 'Jan de Vries' : `Speler ${i + 1}`,
    has_email: i >= noEmail,
  }));
}
