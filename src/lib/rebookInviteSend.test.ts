import { describe, it, expect, vi } from 'vitest';
import { createAndDrainRebookRound, drainRebookInvites, drainRebookRoundInvites, type DrainResult, type SendChunkResult } from './rebookInviteSend';

/** Fill the SendChunkResult defaults so a scripted chunk can specify only the fields it exercises. */
const chunk = (c: Partial<SendChunkResult>): SendChunkResult => ({
  sent: 0, failed: 0, unresolved: 0, remaining: 0, failedClaimIds: [], unresolvedClaimIds: [], sampleError: null, ...c,
});

/** A fake sender that replays a scripted list of chunk results. */
const scripted = (chunks: Array<Partial<SendChunkResult>>) => {
  let i = 0;
  return vi.fn(async () => chunk(chunks[Math.min(i++, chunks.length - 1)]));
};

describe('drainRebookInvites', () => {
  it('loops until remaining hits 0 and sums the sent count', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 60, failedClaimIds: [] },
      { sent: 40, failed: 0, remaining: 20, failedClaimIds: [] },
      { sent: 20, failed: 0, remaining: 0, failedClaimIds: [] },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(100);
    expect(r.leftover).toBe(0);
    expect(sender).toHaveBeenCalledTimes(3);
  });

  it('reports progress as it drains', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [] },
      { sent: 40, failed: 0, remaining: 0, failedClaimIds: [] },
    ]);
    const progress: number[] = [];
    await drainRebookInvites('cyc', { sender, onProgress: (p) => progress.push(p.totalSent) });
    expect(progress).toEqual([40, 80]);
  });

  it('pins a stable sendable total from the first chunk (excludes emailless)', async () => {
    // First chunk: 40 sent + 0 failed + 40 remaining ⇒ sendable total = 80, even
    // though the round may have more (emailless) representatives.
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [] },
      { sent: 40, failed: 0, remaining: 0, failedClaimIds: [] },
    ]);
    const totals: number[] = [];
    await drainRebookInvites('cyc', { sender, onProgress: (p) => totals.push(p.total) });
    expect(totals).toEqual([80, 80]);
  });

  it('stops on no-progress (a whole chunk failed) and reports the leftover', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, remaining: 40, failedClaimIds: [] },
      // Everything in this chunk failed (rolled back) — no forward progress.
      { sent: 0, failed: 40, remaining: 0, failedClaimIds: ['a', 'b'] },
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
      { sent: 40, failed: 0, unresolved: 40, remaining: 0, unresolvedClaimIds: ['u1', 'u2'] },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('unresolved');
    expect(r.leftover).toBe(40); // the 40 un-stamped sends still need resolving
    expect(r.unresolvedClaimIds.sort()).toEqual(['u1', 'u2']);
    expect(sender).toHaveBeenCalledTimes(1); // stops immediately (retryable), never loops re-sending
  });

  it('drains cleanly once a follow-up chunk resolves the earlier remaining work', async () => {
    const sender = scripted([
      { sent: 40, failed: 0, unresolved: 0, remaining: 10 },
      { sent: 10, failed: 0, unresolved: 0, remaining: 0 },
    ]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(50);
    expect(r.leftover).toBe(0);
  });

  it('treats an immediate "nothing to send" as drained (already all invited)', async () => {
    const sender = scripted([{ sent: 0, failed: 0, remaining: 0, failedClaimIds: [] }]);
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

  it('a throw AFTER a chunk keeps the last known outstanding count (not null)', async () => {
    let call = 0;
    const sender = vi.fn(async () => {
      if (call++ === 0) return chunk({ sent: 40, remaining: 50 });
      throw new Error('network');
    });
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.totalSent).toBe(40);
    expect(r.leftover).toBe(50); // a real count WAS learned — surface it, don't collapse to null
  });

  it('hitting maxIterations reports iteration_limit + real leftover, NOT drained (Codex round-8 #1)', async () => {
    // A large run that always sends a little but never fully drains — the 500-iteration backstop must
    // NOT masquerade as a clean drain with leftover 0.
    const sender = vi.fn(async () => chunk({ sent: 1, failed: 0, remaining: 999 }));
    const r = await drainRebookInvites('cyc', { sender, maxIterations: 5 });
    expect(sender).toHaveBeenCalledTimes(5);
    expect(r.totalSent).toBe(5);
    expect(r.stoppedReason).toBe('iteration_limit');
    expect(r.leftover).toBe(999); // outstanding work is surfaced, not hidden
  });

  it('a chunk that sends NOTHING while work remains is no_progress, NOT drained (Codex round-8 #1)', async () => {
    // sent:0 with remaining>0 (e.g. nothing eligible resolved this pass) — must not report drained.
    const sender = vi.fn(async () => chunk({ sent: 0, failed: 0, remaining: 50 }));
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('no_progress');
    expect(r.leftover).toBe(50);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('forwards the chunk limit and custom copy to the sender', async () => {
    const sender = vi.fn(async () => chunk({ sent: 0, failed: 0, remaining: 0 }));
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
  it('drains every sibling cycle and merges the counts into one round result', async () => {
    const sender = scriptedByCycle({
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [] }],
      b: [{ sent: 3, failed: 0, remaining: 0, failedClaimIds: [] }],
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
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [] }],
      b: [{ sent: 0, failed: 2, remaining: 0, failedClaimIds: ['x', 'y'] }], // whole chunk failed → no_progress
    });
    const r = await drainRebookRoundInvites(['a', 'b'], { sender });
    expect(r.totalSent).toBe(2);
    expect(r.leftover).toBe(2);
    expect(r.stoppedReason).toBe('no_progress');
    expect(r.failedClaimIds.sort()).toEqual(['x', 'y']);
  });

  it('a sibling cycle whose first chunk THROWS makes the round leftover null/unknown (Codex round-10 #1)', async () => {
    // Cycle a drains cleanly; cycle b's first send throws before any count is learned. The round total
    // outstanding is then genuinely unknown — it must NOT be summed to a fabricated number.
    const sender = vi.fn(async ({ cycleId }: { cycleId: string }) => {
      if (cycleId === 'a') return chunk({ sent: 5, remaining: 0 });
      throw new Error('cycle b down');
    });
    const r = await drainRebookRoundInvites(['a', 'b'], { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.leftover).toBe(null); // once any cycle's count is unknown, the round leftover is unknown
    expect(r.totalSent).toBe(5);
  });

  it('reports round-level progress rebased across cycles', async () => {
    const sender = scriptedByCycle({
      a: [{ sent: 2, failed: 0, remaining: 0, failedClaimIds: [] }],
      b: [{ sent: 3, failed: 0, remaining: 0, failedClaimIds: [] }],
    });
    const seen: number[] = [];
    await drainRebookRoundInvites(['a', 'b'], { sender, onProgress: (p) => seen.push(p.totalSent) });
    // Running totals never go backwards across the cycle boundary.
    expect(seen).toEqual([2, 5]);
  });

  it('a single-cycle round behaves exactly like the per-cycle drain', async () => {
    const sender = scriptedByCycle({ solo: [{ sent: 4, failed: 0, remaining: 0, failedClaimIds: [] }] });
    const r = await drainRebookRoundInvites(['solo'], { sender });
    expect(r.totalSent).toBe(4);
    expect(r.stoppedReason).toBe('drained');
  });
});

const drainResult = (over: Partial<DrainResult>): DrainResult => ({
  totalSent: 0, leftover: 0, stoppedReason: 'drained', failedClaimIds: [], unresolvedClaimIds: [], sampleError: null, ...over,
});

describe('createAndDrainRebookRound — shared create-then-drain orchestration (Codex round-9 #1/#2)', () => {
  const invokeReturning = (data: unknown) => vi.fn(async () => ({ data, error: null }));

  it('ALWAYS creates without inline sending (skipInvites + roundAware) then drains', async () => {
    const invoke = invokeReturning({ targetCycleId: 'cy1', invitesDeferred: true, targetCycles: [{ id: 'cy1' }], representativeCount: 10 });
    const drain = vi.fn(async () => drainResult({ totalSent: 10 }));
    await createAndDrainRebookRound({ x: 1 }, { invoke, drain });
    // The blocker Codex flagged: this is the ONLY way the round is created — never inline.
    expect(invoke).toHaveBeenCalledWith('bulk-rebook-cycle', { body: { x: 1, skipInvites: true, roundAware: true } });
    expect(drain).toHaveBeenCalledWith(['cy1'], expect.anything());
  });

  it('a CREATION failure (no targetCycleId) → phase creation_failed, never navigable', async () => {
    const invoke = invokeReturning({ ok: false, reason: 'nothing_to_rebook' });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({}, { invoke, drain });
    expect(r).toEqual({ phase: 'creation_failed', reason: 'nothing_to_rebook' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('an explicit phase:creation is a creation failure (already_exists)', async () => {
    const invoke = invokeReturning({ ok: false, phase: 'creation', reason: 'already_exists' });
    const r = await createAndDrainRebookRound({}, { invoke, drain: vi.fn() });
    expect(r.phase).toBe('creation_failed');
    if (r.phase === 'creation_failed') expect(r.reason).toBe('already_exists');
  });

  it('created + deferred + clean drain → created, leftover 0', async () => {
    const invoke = invokeReturning({ targetCycleId: 'cy1', roundId: 'r1', groups: 2, players: 5, invitesDeferred: true, targetCycles: [{ id: 'cy1' }], representativeCount: 5 });
    const drain = vi.fn(async () => drainResult({ totalSent: 5, leftover: 0, stoppedReason: 'drained' }));
    const r = await createAndDrainRebookRound({}, { invoke, drain });
    expect(r).toMatchObject({ phase: 'created', targetCycleId: 'cy1', leftover: 0, outcome: 'drained', totalSent: 5 });
  });

  it('created + deferred + PARTIAL drain (leftover>0) → created with leftover surfaced', async () => {
    const invoke = invokeReturning({ targetCycleId: 'cy1', invitesDeferred: true, targetCycles: [{ id: 'cy1' }], representativeCount: 100 });
    const drain = vi.fn(async () => drainResult({ totalSent: 40, leftover: 60, stoppedReason: 'iteration_limit', sampleError: 'x' }));
    const r = await createAndDrainRebookRound({}, { invoke, drain });
    expect(r).toMatchObject({ phase: 'created', leftover: 60, outcome: 'iteration_limit', sampleError: 'x' });
  });

  it('created + deferred drain that ERRORS before any count → leftover null (unknown), not 0 (round-10 #1)', async () => {
    const invoke = invokeReturning({ targetCycleId: 'cy1', invitesDeferred: true, targetCycles: [{ id: 'cy1' }], representativeCount: 100 });
    const drain = vi.fn(async () => drainResult({ totalSent: 0, leftover: null, stoppedReason: 'error' }));
    const r = await createAndDrainRebookRound({}, { invoke, drain });
    expect(r).toMatchObject({ phase: 'created', leftover: null, outcome: 'error' });
  });

  it('created + INLINE (legacy edge, no invitesDeferred) surfaces failed+unresolved as leftover — no drain', async () => {
    const invoke = invokeReturning({ targetCycleId: 'cy1', invitesSent: 8, failed: 2, unresolved: 1, failedClaimIds: ['a', 'b'], unresolvedClaimIds: ['c'] });
    const drain = vi.fn();
    const r = await createAndDrainRebookRound({}, { invoke, drain });
    expect(drain).not.toHaveBeenCalled();
    expect(r).toMatchObject({ phase: 'created', totalSent: 8, leftover: 3, outcome: 'inline' });
  });
});
