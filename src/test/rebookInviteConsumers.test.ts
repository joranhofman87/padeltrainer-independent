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

describe('sendRebookReminder surfaces the resumable cap boundary (Codex round-6 #3)', () => {
  it('maps `remaining` from the response and reports ok:false when the cap was hit', async () => {
    invokeMock.mockResolvedValue({ data: { ok: false, sent: 200, skipped: 0, failed: 0, remaining: 15 }, error: null });
    const res = await sendRebookReminder({ cycleId: 'cy', targets: [], subject: 's', message: 'm' });
    expect(res.remaining).toBe(15);
    expect(res.ok).toBe(false);
  });

  it('defaults remaining to 0 when absent (clean full send)', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true, sent: 5, skipped: 0, failed: 0 }, error: null });
    const res = await sendRebookReminder({ cycleId: 'cy', targets: [], subject: 's', message: 'm' });
    expect(res.remaining).toBe(0);
    expect(res.ok).toBe(true);
  });
});
