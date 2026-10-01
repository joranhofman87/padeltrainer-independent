import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCancellableExport } from './useCancellableExport';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useCancellableExport', () => {
  it('runs one export at a time and reports running', async () => {
    const { result } = renderHook(() => useCancellableExport('a1'));
    const first = deferred();
    let starts = 0;
    let done!: Promise<void>;
    act(() => { done = result.current.run(async () => { starts++; await first.promise; }); });
    expect(result.current.running).toBe(true);
    await act(async () => { await result.current.run(async () => { starts++; }); }); // ignored: single-flight
    expect(starts).toBe(1);
    await act(async () => { first.resolve(); await done; });
    expect(result.current.running).toBe(false);
    await act(async () => { await result.current.run(async () => { starts++; }); }); // free again
    expect(starts).toBe(2);
  });

  it('cancel aborts the running task signal; a task error still clears running', async () => {
    const { result } = renderHook(() => useCancellableExport('a1'));
    let seen: AbortSignal | undefined;
    const gate = deferred();
    let done!: Promise<void>;
    act(() => { done = result.current.run(async (signal) => { seen = signal; await gate.promise; throw new Error('boom'); }); });
    act(() => result.current.cancel());
    expect(seen?.aborted).toBe(true);
    await act(async () => { gate.resolve(); await done.catch(() => {}); });
    expect(result.current.running).toBe(false);
  });

  it('a scope change and an unmount each abort the running task', async () => {
    const { result, rerender, unmount } = renderHook(({ scope }) => useCancellableExport(scope), { initialProps: { scope: 'a1' } });
    let first: AbortSignal | undefined;
    const gate = deferred();
    let done!: Promise<void>;
    act(() => { done = result.current.run(async (signal) => { first = signal; await gate.promise; }); });
    rerender({ scope: 'a1' });
    expect(first?.aborted).toBe(false); // same scope: untouched
    rerender({ scope: 'a2' });
    expect(first?.aborted).toBe(true);
    await act(async () => { gate.resolve(); await done; });

    let second: AbortSignal | undefined;
    act(() => { void result.current.run(async (signal) => { second = signal; await new Promise(() => {}); }); });
    unmount();
    expect(second?.aborted).toBe(true);
  });
});
