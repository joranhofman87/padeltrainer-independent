import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above const declarations, so the shared mocks must be created via
// vi.hoisted (also hoisted) to be referenceable inside the factories.
const { invokeMock, warnMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), warnMock: vi.fn() }));
// Bespoke supabase mock exposing functions.invoke (the fixtures/supabaseMock only models from/rpc).
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invokeMock(...a) }, rpc: vi.fn(), from: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: warnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { sendRebookGroupConfirmations } from '@/lib/priorityClaims';
import { sendRebookReminder } from '@/lib/rebookManage';

// sendRebookGroupConfirmations is fire-and-forget (void); flush the microtask/timer queue so its
// .then handler runs before we assert.
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { invokeMock.mockReset(); warnMock.mockReset(); });

describe('sendRebookGroupConfirmations surfaces non-clean results (Codex round-6 #2)', () => {
  it('warns when the call was THROTTLED (a legitimate 7th group edit that sent nothing)', async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, throttled: true, sent: 0, skipped: 0, failed: 0, unresolved: 0 }, error: null });
    sendRebookGroupConfirmations('tok');
    await flush();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatchObject({ throttled: true });
  });

  it('warns when a member was SKIPPED (no email for someone the captain just booked)', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, sent: 1, skipped: 1, failed: 0, unresolved: 0 }, error: null });
    sendRebookGroupConfirmations('tok');
    await flush();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatchObject({ skipped: 1 });
  });

  it('warns on an unresolved send', async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, sent: 1, skipped: 0, failed: 0, unresolved: 1 }, error: null });
    sendRebookGroupConfirmations('tok');
    await flush();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatchObject({ unresolved: 1 });
  });

  it('does NOT warn on a fully clean send (nothing skipped/failed/unresolved/throttled)', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, sent: 2, skipped: 0, failed: 0, unresolved: 0 }, error: null });
    sendRebookGroupConfirmations('tok');
    await flush();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('sendRebookReminder batches identities + returns the failed retry set (Codex round-7 #2)', () => {
  const okBatch = (_fn: string, opts: { body: { targets: unknown[] } }) => {
    return Promise.resolve({ data: { ok: true, sent: opts.body.targets.length, skipped: 0, failed: 0, failedTargets: [] }, error: null });
  };

  it('sends each identity exactly once across <=200-target batches (no duplicate, no silent cap)', async () => {
    const targets = Array.from({ length: 250 }, (_, i) => ({ player_id: `p${i}`, guest_player_id: null }));
    const batchSizes: number[] = [];
    invokeMock.mockImplementation((_fn: string, opts: { body: { targets: unknown[] } }) => {
      batchSizes.push(opts.body.targets.length);
      return okBatch(_fn, opts);
    });
    const res = await sendRebookReminder({ cycleId: 'cy', targets, subject: 's', message: 'm' });
    expect(batchSizes).toEqual([200, 50]); // 250 identities → two bounded batches
    expect(res.sent).toBe(250); // each sent exactly once
    expect(res.ok).toBe(true);
  });

  it('dedups duplicate identities so no recipient is reminded twice', async () => {
    const targets = [{ player_id: 'p1', guest_player_id: null }, { player_id: 'p1', guest_player_id: null }, { player_id: 'p2', guest_player_id: null }];
    let totalSent = 0;
    invokeMock.mockImplementation((_fn: string, opts: { body: { targets: unknown[] } }) => {
      totalSent += opts.body.targets.length;
      return okBatch(_fn, opts);
    });
    await sendRebookReminder({ cycleId: 'cy', targets, subject: 's', message: 'm' });
    expect(totalSent).toBe(2); // the duplicate p1 collapsed to one
  });

  it('aggregates failedTargets across batches and reports ok:false', async () => {
    const targets = Array.from({ length: 3 }, (_, i) => ({ player_id: `p${i}`, guest_player_id: null }));
    invokeMock.mockResolvedValue({ data: { ok: false, sent: 2, skipped: 0, failed: 1, failedTargets: [{ player_id: 'p2', guest_player_id: null }] }, error: null });
    const res = await sendRebookReminder({ cycleId: 'cy', targets, subject: 's', message: 'm' });
    expect(res.ok).toBe(false);
    expect(res.failed).toBe(1);
    expect(res.failedTargets).toEqual([{ player_id: 'p2', guest_player_id: null }]); // the exact retry set
  });

  it('a whole-batch invoke error puts the entire batch into failedTargets', async () => {
    const targets = [{ player_id: 'p1', guest_player_id: null }];
    invokeMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await sendRebookReminder({ cycleId: 'cy', targets, subject: 's', message: 'm' });
    expect(res.ok).toBe(false);
    expect(res.failedTargets).toEqual([{ player_id: 'p1', guest_player_id: null }]);
    expect(res.reason).toBe('boom');
  });

  it('an empty selection is a clean no-op (never calls the edge)', async () => {
    const res = await sendRebookReminder({ cycleId: 'cy', targets: [], subject: 's', message: 'm' });
    expect(res.ok).toBe(true);
    expect(res.sent).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
