import { describe, it, expect, vi } from 'vitest';
import { drainRebookInvites, type SendChunkResult } from './rebookInviteSend';

/** A fake sender that replays a scripted list of chunk results. */
const scripted = (chunks: SendChunkResult[]) => {
  let i = 0;
  return vi.fn(async () => chunks[Math.min(i++, chunks.length - 1)]);
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

  it('treats an immediate "nothing to send" as drained (already all invited)', async () => {
    const sender = scripted([{ sent: 0, failed: 0, remaining: 0, failedClaimIds: [] }]);
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('drained');
    expect(r.totalSent).toBe(0);
    expect(r.leftover).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('stops on a thrown sender error without looping forever', async () => {
    const sender = vi.fn(async () => { throw new Error('network'); });
    const r = await drainRebookInvites('cyc', { sender });
    expect(r.stoppedReason).toBe('error');
    expect(r.totalSent).toBe(0);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('honours maxIterations as a runaway backstop', async () => {
    // A pathological sender that always claims progress but never drains.
    const sender = vi.fn(async () => ({ sent: 1, failed: 0, remaining: 999, failedClaimIds: [] }));
    const r = await drainRebookInvites('cyc', { sender, maxIterations: 5 });
    expect(sender).toHaveBeenCalledTimes(5);
    expect(r.totalSent).toBe(5);
  });

  it('forwards the chunk limit and custom copy to the sender', async () => {
    const sender = vi.fn(async () => ({ sent: 0, failed: 0, remaining: 0, failedClaimIds: [] }));
    await drainRebookInvites('cyc', { sender, limit: 25, customMessage: 'hi', customSubject: 'subj' });
    expect(sender).toHaveBeenCalledWith({ cycleId: 'cyc', limit: 25, customMessage: 'hi', customSubject: 'subj' });
  });
});
