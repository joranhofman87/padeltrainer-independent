import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyToClipboard } from './useCopyToClipboard';

describe('useCopyToClipboard', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.assign(navigator, { clipboard: { writeText } });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });

  it('copies via the async Clipboard API and flips copied=true', async () => {
    writeText.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCopyToClipboard());
    let ok!: boolean;
    await act(async () => { ok = await result.current.copy('hello'); });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(result.current.copied).toBe(true);
  });

  it('falls back to execCommand when the Clipboard API throws (non-secure context / old browser)', async () => {
    writeText.mockRejectedValue(new Error('blocked'));
    const exec = vi.fn().mockReturnValue(true); // jsdom has no execCommand — define it
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    const { result } = renderHook(() => useCopyToClipboard());
    let ok!: boolean;
    await act(async () => { ok = await result.current.copy('hi'); });
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('returns false and stays uncopied when BOTH paths fail', async () => {
    writeText.mockRejectedValue(new Error('blocked'));
    const exec = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    const { result } = renderHook(() => useCopyToClipboard());
    let ok!: boolean;
    await act(async () => { ok = await result.current.copy('x'); });
    expect(ok).toBe(false);
    expect(result.current.copied).toBe(false);
  });
});
